import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { encode } from "gpt-tokenizer";
import { loadChatModel } from "./utils.js";

/**
 * 短期记忆：会话内上下文管理。
 *
 * 状态里仍保留完整历史（由 checkpointer 负责），这里只决定「发给模型的上下文」：
 * 1. 按 token 预算从尾部取最近的消息；
 * 2. 预算之外、尚未压缩的历史折叠成滚动摘要；
 * 3. 摘要随系统提示词一起注入，因此早期信息不会被硬生生丢掉。
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 6000;

/** 攒够这么多 token 的未压缩内容才触发一次摘要，避免每轮都多花一次模型调用。 */
export const MIN_SUMMARY_TOKENS = 800;

/** 每条消息除正文外的固定开销（role、分隔符等）。 */
const PER_MESSAGE_OVERHEAD = 4;

/** 单张图片的 token 估算，用于上下文预算（各家视觉模型大致 800~1200）。 */
export const IMAGE_TOKEN_ESTIMATE = 1000;

const SUMMARY_PROMPT = `你是一个对话摘要助手。请把给出的历史对话压缩成简洁要点，只保留：
1. 用户的目标、偏好与约束；
2. 已经确认的结论和事实；
3. 尚未完成的事项；
4. 关键的专有名词、数值、代码标识符。
不要编造内容，不要输出寒暄，使用中文，控制在 300 字以内。`;

export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

/** 把消息压成可计数的文本；多模态块只保留占位符，避免把 URL/base64 算进 token。 */
export function messageToText(message: BaseMessage): string {
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : content
          .map((block) => {
            switch (block.type) {
              case "text":
                return block.text;
              case "image_url":
                return "[图片]";
              case "file":
              case "file_url":
                return "[附件]";
              case "audio":
                return "[音频]";
              default:
                return `[${block.type}]`;
            }
          })
          .join(" ");
  const toolCalls = (message as AIMessage).tool_calls;
  const calls = toolCalls?.length ? JSON.stringify(toolCalls) : "";
  return `${message.type}: ${text} ${calls}`.trim();
}

function countImages(message: BaseMessage): number {
  if (typeof message.content === "string") return 0;
  return message.content.filter((block) => block.type === "image_url").length;
}

export function countMessageTokens(message: BaseMessage): number {
  return (
    countTokens(messageToText(message)) +
    PER_MESSAGE_OVERHEAD +
    countImages(message) * IMAGE_TOKEN_ESTIMATE
  );
}

/**
 * 按 token 预算选出最近的消息。
 * 返回的 recent 至少包含一条消息；older 是预算之外、需要被摘要的历史。
 */
export function selectRecentMessages(
  messages: BaseMessage[],
  maxTokens: number = DEFAULT_MAX_CONTEXT_TOKENS,
): { recent: BaseMessage[]; older: BaseMessage[] } {
  if (maxTokens <= 0 || messages.length === 0) {
    return { recent: messages, older: [] };
  }

  let total = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = countMessageTokens(messages[i]);
    // 至少要保留一条消息，否则空上下文无法回答
    if (total + tokens > maxTokens && start < messages.length) break;
    total += tokens;
    start = i;
  }

  // 不能以 tool 消息开头：它对应的 AI 工具调用会被排除在窗口外，消息结构非法
  while (start > 0 && messages[start].type === "tool") {
    start--;
  }

  return {
    recent: messages.slice(start),
    older: messages.slice(0, start),
  };
}

/** 取最后一条人类消息的文本，用于长期记忆相关性检索。 */
export function getLatestHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "human") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      return content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(" ");
    }
  }
  return "";
}

/** 把滚动摘要包装成系统提示词片段。 */
export function formatSummary(summary?: string): string {
  if (!summary?.trim()) return "";
  return `\n\n<conversation_summary>\n以下是本次会话早期内容的摘要，可作为背景参考：\n${summary.trim()}\n</conversation_summary>`;
}

/**
 * 增量更新滚动摘要：只压缩 summaryUpTo 之后、且已滑出窗口的历史。
 * 未压缩内容不足 MIN_SUMMARY_TOKENS 时直接返回原摘要，避免频繁调用模型。
 */
export async function updateSummary({
  older,
  summary,
  summaryUpTo,
  modelName,
}: {
  older: BaseMessage[];
  summary: string;
  summaryUpTo: string;
  modelName: string;
}): Promise<{ summary: string; summaryUpTo: string }> {
  let pending = older;
  if (summaryUpTo) {
    const index = older.findIndex((message) => message.id === summaryUpTo);
    // 找不到锚点（例如历史被裁剪过）时，保守地认为全部都还没压缩
    pending = index === -1 ? older : older.slice(index + 1);
  }
  if (pending.length === 0) return { summary, summaryUpTo };

  const tokens = pending.reduce(
    (total, message) => total + countMessageTokens(message),
    0,
  );
  if (tokens < MIN_SUMMARY_TOKENS) return { summary, summaryUpTo };

  const transcript = pending
    .map((message) => messageToText(message))
    .join("\n")
    .slice(0, 24000);

  const model = await loadChatModel(modelName);
  const response = await model.invoke([
    { role: "system", content: SUMMARY_PROMPT },
    {
      role: "user",
      content: `已有摘要：\n${summary.trim() || "（无）"}\n\n新增对话：\n${transcript}`,
    },
  ]);

  const next =
    typeof response.content === "string"
      ? response.content
      : response.content
          .filter((block) => block.type === "text")
          .map((block) => (block as { text: string }).text)
          .join(" ");

  const lastPending = pending[pending.length - 1];
  return {
    summary: next.trim() || summary,
    summaryUpTo: lastPending.id ?? summaryUpTo,
  };
}
