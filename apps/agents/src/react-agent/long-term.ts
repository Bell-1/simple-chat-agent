import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/**
 * 长期记忆：跨会话持久的事实存储。
 *
 * 这里用本地 JSON 文件落地，零外部依赖、便于本地开发与演示；
 * 生产环境可把 readAll / mutate 换成 MongoDB 或带向量索引的 BaseStore。
 */
export interface MemoryRecord {
  id: string;
  content: string;
  createdAt: string;
}

type MemoryFile = Record<string, MemoryRecord[]>;

const DATA_FILE = fileURLToPath(
  new URL("../../.data/memories.json", import.meta.url),
);
const MAX_PER_USER = 200;

/** 写操作串行化，避免并发调用工具时互相覆盖文件。 */
let writeChain: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<MemoryFile> {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8")) as MemoryFile;
  } catch {
    // 文件不存在或内容损坏时视为空
    return {};
  }
}

async function mutate<T>(fn: (data: MemoryFile) => T): Promise<T> {
  const run = async () => {
    const data = await readAll();
    const result = fn(data);
    await mkdir(dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
    return result;
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}

/** 写入一条事实，内容完全相同的视为同一条，不重复存。 */
export async function addMemory(
  userId: string,
  content: string,
): Promise<MemoryRecord> {
  const text = content.trim();
  if (!text) throw new Error("记忆内容不能为空");

  return mutate((data) => {
    const list = data[userId] ?? [];
    const existed = list.find((m) => m.content === text);
    if (existed) return existed;

    const record: MemoryRecord = {
      id: randomUUID(),
      content: text,
      createdAt: new Date().toISOString(),
    };
    // 新记忆放最前，超出上限时淘汰最旧的
    data[userId] = [record, ...list].slice(0, MAX_PER_USER);
    return record;
  });
}

export async function listMemories(
  userId: string,
  limit = MAX_PER_USER,
): Promise<MemoryRecord[]> {
  const data = await readAll();
  return (data[userId] ?? []).slice(0, limit);
}

/**
 * 关键词相关性检索。
 * 中文按字符二元组切分（无需分词器），英文/数字按单词切分。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    tokens.add(word);
  }
  const han = text.replace(/[^\u4e00-\u9fa5]/g, "");
  if (han.length === 1) tokens.add(han);
  for (let i = 0; i + 1 < han.length; i++) {
    tokens.add(han.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 取与 query 最相关的记忆；命中不足时用最近的记忆补足，
 * 保证「上次聊过的偏好」在换个话题后依然能被带上。
 */
export async function searchMemories(
  userId: string,
  query: string,
  limit = 8,
): Promise<MemoryRecord[]> {
  const list = await listMemories(userId, MAX_PER_USER);
  if (!list.length) return [];

  const queryTokens = tokenize(query);
  if (!queryTokens.size) return list.slice(0, limit);

  const scored = list
    .map((record, index) => {
      const tokens = tokenize(record.content);
      let score = 0;
      for (const token of tokens) {
        if (queryTokens.has(token)) score++;
      }
      // index 越小越新，作为同分时的次级排序依据
      return { record, score, index };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.record);

  const rest = list.filter((record) => !scored.includes(record));
  return [...scored, ...rest].slice(0, limit);
}

/** 拼成注入 system prompt 的记忆块。 */
export function formatMemories(memories: MemoryRecord[]): string {
  if (!memories.length) return "";
  const lines = memories.map((m) => `- ${m.content}`).join("\n");
  return `\n\n<memories>\n以下是你在过往对话中记住的关于该用户的长期信息，按需使用，不要整块复述：\n${lines}\n</memories>`;
}
