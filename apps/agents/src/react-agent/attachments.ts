import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { ModelCapabilities } from "./model-capabilities.js";

/**
 * 附件注入：把用户消息里的附件转换成模型能理解的内容块。
 *
 * - 图片：模型支持视觉时转成 data URL 直接送入；不支持时退化为文字占位。
 * - 文档/音频/视频：读取上传服务里已解析好的文本，按字符预算截断后注入。
 * 只处理最后一条人类消息，历史消息仍走占位符，避免每轮重复发送大段内容。
 */
const UPLOAD_BASE = (
  process.env.UPLOAD_SERVICE_URL ||
  `http://localhost:${process.env.UPLOAD_PORT || 2025}`
).replace(/\/$/, "");

/** 单张图片的最大字节数，超过时退化为文字占位，避免请求体过大。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 单轮注入的解析文本总字符上限（约 6~7k token）。 */
const MAX_INJECTED_CHARS = 20_000;

const FETCH_TIMEOUT_MS = 15_000;

export type AttachmentKind = "image" | "document" | "audio" | "video";

export interface AttachmentMeta {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size?: number;
  url?: string;
  parse?: { status: string; error?: string };
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** 读取消息上携带的附件元数据（由前端在 additional_kwargs 中写入）。 */
export function getMessageAttachments(
  message: BaseMessage,
): AttachmentMeta[] {
  const raw = message.additional_kwargs?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is AttachmentMeta =>
      !!item &&
      typeof item === "object" &&
      typeof (item as AttachmentMeta).id === "string" &&
      typeof (item as AttachmentMeta).kind === "string",
  );
}

function textBlocksOf(message: BaseMessage): ContentBlock[] {
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => ({ type: "text", text: block.text }));
}

async function fetchWithTimeout(
  path: string,
  accept: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${UPLOAD_BASE}${path}`, {
      headers: { Accept: accept },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function toDataUrl(
  attachment: AttachmentMeta,
): Promise<ContentBlock | null> {
  try {
    const response = await fetchWithTimeout(
      `/uploads/${attachment.id}/content`,
      "image/*",
    );
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const mime = response.headers.get("content-type") || attachment.mime;
    return {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` },
    };
  } catch {
    return null;
  }
}

async function fetchParsedText(
  attachment: AttachmentMeta,
): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(
      `/uploads/${attachment.id}/text`,
      "text/plain",
    );
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** 把单个附件转换成内容块；无法转换时返回说明性的文字占位。 */
async function toContentBlocks(
  attachment: AttachmentMeta,
  capabilities: ModelCapabilities,
  budget: { remaining: number },
): Promise<ContentBlock[]> {
  if (attachment.kind === "image") {
    if (!capabilities.vision) {
      return [
        {
          type: "text",
          text: `[用户发送了图片「${attachment.name}」，当前模型不支持视觉输入，内容未提供]`,
        },
      ];
    }
    const image = await toDataUrl(attachment);
    if (!image) {
      return [
        {
          type: "text",
          text: `[用户发送了图片「${attachment.name}」，但读取失败，内容未提供]`,
        },
      ];
    }
    return [image];
  }

  const status = attachment.parse?.status;
  if (status !== "ready") {
    const reason =
      status === "failed"
        ? `解析失败：${attachment.parse?.error ?? "未知原因"}`
        : "仍在解析中";
    return [
      {
        type: "text",
        text: `[用户发送了附件「${attachment.name}」，${reason}，内容未提供]`,
      },
    ];
  }

  const text = await fetchParsedText(attachment);
  if (!text) {
    return [
      {
        type: "text",
        text: `[用户发送了附件「${attachment.name}」，读取失败，内容未提供]`,
      },
    ];
  }

  const allowed = Math.min(budget.remaining, text.length);
  if (allowed <= 0) {
    return [
      {
        type: "text",
        text: `[附件「${attachment.name}」超出本轮上下文预算，已省略内容]`,
      },
    ];
  }
  budget.remaining -= allowed;
  const truncated = allowed < text.length;
  return [
    {
      type: "text",
      text: `【附件：${attachment.name}】\n${text.slice(0, allowed)}${
        truncated ? "\n…[附件内容过长，已截断]" : ""
      }`,
    },
  ];
}

/**
 * 把最后一条人类消息的附件展开成内容块（图片 / 解析文本）。
 * 没有附件时原样返回，不产生额外开销。
 */
export async function enrichLatestHumanMessage(
  messages: BaseMessage[],
  capabilities: ModelCapabilities,
): Promise<BaseMessage[]> {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "human") {
      index = i;
      break;
    }
  }
  if (index === -1) return messages;

  const target = messages[index];
  const attachments = getMessageAttachments(target);
  if (attachments.length === 0) return messages;

  const budget = { remaining: MAX_INJECTED_CHARS };
  const blocks: ContentBlock[] = textBlocksOf(target);
  for (const attachment of attachments) {
    blocks.push(...(await toContentBlocks(attachment, capabilities, budget)));
  }

  const enriched = new HumanMessage({
    content: blocks as unknown as HumanMessage["content"],
    id: target.id,
    name: target.name,
    additional_kwargs: target.additional_kwargs,
    response_metadata: target.response_metadata,
  });

  return messages.map((message, i) => (i === index ? enriched : message));
}
