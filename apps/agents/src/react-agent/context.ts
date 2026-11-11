import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import {
  selectRecentMessages,
  messageToText,
  countMessageTokens,
} from "./short-term.js";
import { tokenize } from "./long-term.js";
import { loadChatModel } from "./utils.js";

/**
 * 上下文构建：在「不改动 checkpoint 历史」的前提下，尽量压缩发给模型的内容。
 *
 * 分三层裁剪：
 * 1. 时间窗口：沿用 token 预算，只取最近消息；
 * 2. 相关性筛选：窗口内除最近 N 轮外，其余按与当前问题的相关度只保留 top-K；
 * 3. 内容降级：早期工具结果截断/去重，低信息量的闲聊轮次折叠。
 */

/** 无论如何都完整保留的最近轮次。 */
const RECENT_TURNS = 6;

/** 窗口内较早轮次按相关度保留的数量。 */
const RELEVANT_ROUNDS = 3;

/** 非最近工具结果的最大字符数。 */
const TOOL_RESULT_MAX_CHARS = 200;

/** 完整保留的工具结果条数（从最新往前数）。 */
const KEEP_FULL_TOOL_RESULTS = 1;

/** 规则初筛：闲聊消息的最大长度。 */
const CHITCHAT_MAX_HUMAN_CHARS = 20;
const CHITCHAT_MAX_AI_CHARS = 60;

/** 单次最多送去模型判定的候选数，避免提示词过长。 */
const MAX_CHITCHAT_CANDIDATES = 20;

/** 规则初筛时出现这些词，说明大概率包含需求或指令，不当作闲聊。 */
const INSTRUCTION_PATTERN =
  /请|帮|需要|不要|别|必须|记得|记住|改成|修改|实现|写|生成|查|找|解释|为什么|如何|怎么|多少|哪/;

/** 模型判定结果缓存，避免同一轮每次调用都重复判定。 */
const chitchatCache = new Map<string, boolean>();

const CHITCHAT_PROMPT = `你是一个对话价值判断器。给你若干条用户消息，判断每条是否属于「无信息量的闲聊」。
属于闲聊的例子：问候、道谢、寒暄、情绪附和、无具体需求的确认（如“好的”“嗯嗯”“辛苦了”）。
只要包含需求、约束、事实、数字、专有名词或明确指令，就不算闲聊。
只输出 JSON 数组，列出属于闲聊的序号，例如 [0,2]。不确定时不要列入。`;

function textOf(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

/** 按 human 消息切分轮次，保证工具调用与结果留在同一轮内。 */
function splitRounds(messages: BaseMessage[]): BaseMessage[][] {
  const rounds: BaseMessage[][] = [];
  let current: BaseMessage[] = [];
  for (const message of messages) {
    if (message.type === "human" && current.length > 0) {
      rounds.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) rounds.push(current);
  return rounds;
}

function scoreRound(round: BaseMessage[], queryTokens: Set<string>): number {
  const tokens = tokenize(round.map((message) => messageToText(message)).join(" "));
  let score = 0;
  for (const token of tokens) {
    if (queryTokens.has(token)) score++;
  }
  return score;
}

function cloneToolMessage(message: ToolMessage, content: string): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: message.tool_call_id,
    name: message.name,
    id: message.id,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}

/**
 * 工具结果降级：
 * - 完全重复的结果只保留第一次（后续替换为省略标记）；
 * - 除最近 KEEP_FULL_TOOL_RESULTS 条外，过长的结果截断。
 */
function compactToolResults(messages: BaseMessage[]): BaseMessage[] {
  const indexes = messages
    .map((message, index) => (message.type === "tool" ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return messages;

  const keepFull = new Set(indexes.slice(-KEEP_FULL_TOOL_RESULTS));
  const seen = new Map<string, number>();

  return messages.map((message, index) => {
    if (message.type !== "tool") return message;
    const toolMessage = message as ToolMessage;
    const content = textOf(toolMessage);
    const key = `${toolMessage.name ?? "tool"}|${content.length}|${content.slice(0, 120)}`;

    if (seen.has(key)) {
      return cloneToolMessage(toolMessage, "[重复的工具结果，已省略]");
    }
    seen.set(key, index);

    if (keepFull.has(index) || content.length <= TOOL_RESULT_MAX_CHARS) {
      return toolMessage;
    }
    return cloneToolMessage(
      toolMessage,
      `${content.slice(0, TOOL_RESULT_MAX_CHARS)}…[已省略 ${
        content.length - TOOL_RESULT_MAX_CHARS
      } 字]`,
    );
  });
}

/** 无差别截断工具结果（用于较早、按相关性召回的轮次）。 */
function truncateAllToolResults(
  messages: BaseMessage[],
  maxChars: number,
): BaseMessage[] {
  return messages.map((message) => {
    if (message.type !== "tool") return message;
    const toolMessage = message as ToolMessage;
    const content = textOf(toolMessage);
    if (content.length <= maxChars) return message;
    return cloneToolMessage(
      toolMessage,
      `${content.slice(0, maxChars)}…[已省略 ${content.length - maxChars} 字]`,
    );
  });
}

/** 规则初筛：短、无问句、无数字、无工具调用、无指令词。 */
function isChitchatCandidate(round: BaseMessage[]): boolean {
  const first = round[0];
  if (!first || first.type !== "human") return false;

  const text = textOf(first).trim();
  if (!text || text.length > CHITCHAT_MAX_HUMAN_CHARS) return false;
  if (/[?？0-9]/.test(text)) return false;
  if (INSTRUCTION_PATTERN.test(text)) return false;

  for (const message of round) {
    if (message.type === "tool") return false;
    if (message.type === "ai") {
      if ((message as AIMessage).tool_calls?.length) return false;
      if (textOf(message).length > CHITCHAT_MAX_AI_CHARS) return false;
    }
  }
  return true;
}

function roundKey(round: BaseMessage[]): string {
  const first = round[0];
  return first.id ?? `content:${textOf(first)}`;
}

/** 交给模型批量判定哪些候选轮次确实属于闲聊。判定失败时保守地全部保留。 */
async function classifyChitchat(
  candidates: { round: BaseMessage[]; key: string }[],
  modelName: string,
): Promise<void> {
  if (candidates.length === 0) return;

  const list = candidates
    .slice(0, MAX_CHITCHAT_CANDIDATES)
    .map((item, index) => `${index}. ${textOf(item.round[0]).trim()}`)
    .join("\n");

  let chitchatIndexes: number[] = [];
  try {
    const model = await loadChatModel(modelName);
    const response = await model.invoke([
      { role: "system", content: CHITCHAT_PROMPT },
      { role: "user", content: list },
    ]);
    const raw =
      typeof response.content === "string"
        ? response.content
        : textOf(response as unknown as BaseMessage);
    const match = raw.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as unknown;
      if (Array.isArray(parsed)) {
        chitchatIndexes = parsed.filter(
          (value): value is number => typeof value === "number",
        );
      }
    }
  } catch {
    // 判定失败时不下结论，全部按非闲聊处理
    chitchatIndexes = [];
  }

  candidates.slice(0, MAX_CHITCHAT_CANDIDATES).forEach((item, index) => {
    chitchatCache.set(item.key, chitchatIndexes.includes(index));
  });
}

/** 把确认过的闲聊轮次压成一条占位消息，节省 token 但保留轮次存在感。 */
async function foldChitchat(
  messages: BaseMessage[],
  modelName: string,
): Promise<BaseMessage[]> {
  const rounds = splitRounds(messages);
  if (rounds.length === 0) return messages;

  // 最后一轮是当前问题，永远不折叠
  const foldable = rounds.slice(0, -1);
  const candidates = foldable
    .filter(isChitchatCandidate)
    .map((round) => ({ round, key: roundKey(round) }));

  const uncached = candidates.filter((item) => !chitchatCache.has(item.key));
  if (uncached.length > 0) {
    await classifyChitchat(uncached, modelName);
  }

  const result: BaseMessage[] = [];
  // 连续折叠的闲聊合并成一条占位消息，避免出现多条相邻的 human 消息
  let foldedCount = 0;
  let foldedId: string | undefined;

  const flushFolded = () => {
    if (foldedCount === 0) return;
    result.push(
      new HumanMessage({
        content: `（此前 ${foldedCount} 轮为无信息量的闲聊，已省略）`,
        id: foldedId,
      }),
    );
    foldedCount = 0;
    foldedId = undefined;
  };

  for (const round of rounds) {
    const isFoldable = foldable.includes(round);
    const key = roundKey(round);
    if (isFoldable && chitchatCache.get(key)) {
      foldedCount++;
      foldedId ??= round[0].id;
      continue;
    }
    flushFolded();
    result.push(...round);
  }
  flushFolded();
  return result;
}

/**
 * 构建发给模型的上下文。
 * 返回的 older 是「窗口外 + 窗口内被过滤掉」的历史，交给滚动摘要继续压缩。
 */
export async function buildContext(
  messages: BaseMessage[],
  options: {
    maxContextTokens: number;
    query: string;
    modelName: string;
  },
): Promise<{ context: BaseMessage[]; older: BaseMessage[] }> {
  // 先按轮次切分全部历史：最近 RECENT_TURNS 轮固定保留，其余轮次参与相关性召回
  const allRounds = splitRounds(messages);
  const tailCount = Math.min(RECENT_TURNS, allRounds.length);
  const tailRounds = allRounds.slice(allRounds.length - tailCount);
  const headRounds = allRounds.slice(0, allRounds.length - tailCount);

  const totalTokens = (list: BaseMessage[]) =>
    list.reduce((total, message) => total + countMessageTokens(message), 0);

  // 工具结果先降级再做预算判断，避免一条大结果独占上下文
  let tailMessages = compactToolResults(tailRounds.flat());
  let tailTokens = totalTokens(tailMessages);

  // 最近若干轮本身就超预算时，退化为按 token 从尾部裁剪，并保证从完整轮次开始
  if (tailTokens > options.maxContextTokens) {
    const { recent } = selectRecentMessages(
      tailMessages,
      options.maxContextTokens,
    );
    const firstHuman = recent.findIndex((message) => message.type === "human");
    tailMessages = firstHuman > 0 ? recent.slice(firstHuman) : recent;
    tailTokens = totalTokens(tailMessages);
  }

  let headBudget = Math.max(0, options.maxContextTokens - tailTokens);
  const queryTokens = tokenize(options.query);

  const scored = headRounds
    .map((round, index) => ({
      round,
      index,
      score: queryTokens.size ? scoreRound(round, queryTokens) : 0,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const selected: { round: BaseMessage[]; index: number }[] = [];
  for (const item of scored) {
    if (selected.length >= RELEVANT_ROUNDS || headBudget <= 0) break;
    // 较早轮次里的工具结果只保留摘要性内容，避免单条命中撑爆预算
    const candidate = truncateAllToolResults(item.round, TOOL_RESULT_MAX_CHARS);
    const tokens = totalTokens(candidate);
    if (tokens > headBudget) continue;
    headBudget -= tokens;
    selected.push({ round: candidate, index: item.index });
  }
  selected.sort((a, b) => a.index - b.index);

  const selectedIndexes = new Set(selected.map((item) => item.index));
  const dropped: BaseMessage[] = [];
  headRounds.forEach((round, index) => {
    if (!selectedIndexes.has(index)) dropped.push(...round);
  });

  const keptHead: BaseMessage[] = [];
  if (dropped.length > 0) {
    keptHead.push(
      new SystemMessage({
        content: `[上下文省略：${headRounds.length - selected.length} 轮与本轮无关或超出预算的早期对话已移除]`,
      }),
    );
  }
  for (const item of selected) keptHead.push(...item.round);

  let context: BaseMessage[] = [...keptHead, ...tailMessages];
  context = await foldChitchat(context, options.modelName);

  // 未进入上下文的轮次全部交给摘要，避免信息彻底丢失
  return { context, older: dropped };
}
