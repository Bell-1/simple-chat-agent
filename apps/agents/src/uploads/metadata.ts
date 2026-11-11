import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachmentRecord } from "./types.js";

/**
 * 附件元数据登记表。
 *
 * 只是元数据，不存二进制；对象本体在 S3/OSS 或本地 .data/uploads 下。
 * 与长期记忆一样用 JSON 文件落地，便于本地开发与演示。
 */
const DATA_FILE = fileURLToPath(
  new URL("../../.data/uploads.json", import.meta.url),
);

type Registry = Record<string, AttachmentRecord>;

/** 写操作串行化，避免并发上传时互相覆盖。 */
let writeChain: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<Registry> {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8")) as Registry;
  } catch {
    return {};
  }
}

async function mutate<T>(fn: (data: Registry) => T): Promise<T> {
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

export async function saveRecord(record: AttachmentRecord): Promise<void> {
  await mutate((data) => {
    data[record.id] = record;
  });
}

export async function getRecord(
  id: string,
): Promise<AttachmentRecord | undefined> {
  return (await readAll())[id];
}

export async function deleteRecord(id: string): Promise<void> {
  await mutate((data) => {
    delete data[id];
  });
}

/** 列出某个时间点之前仍处于 pending 的记录，供清理任务使用。 */
export async function listExpiredPending(
  before: Date,
): Promise<AttachmentRecord[]> {
  const data = await readAll();
  return Object.values(data).filter(
    (record) =>
      record.status === "pending" && new Date(record.createdAt) < before,
  );
}
