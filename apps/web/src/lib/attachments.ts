/**
 * 附件上传：申请直传地址 → 直传对象存储 → 确认 → 轮询解析结果。
 * 与 apps/agents/src/uploads 的接口一一对应，通过 Vite 代理走 /uploads。
 */
export type AttachmentKind = "image" | "document" | "audio" | "video";

export interface ParsedState {
  status: "pending" | "running" | "ready" | "failed" | "skipped";
  chars?: number;
  pages?: number;
  truncated?: boolean;
  error?: string;
}

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  status: "pending" | "ready";
  url?: string;
  parse?: ParsedState;
  createdAt?: string;
}

export const MAX_ATTACHMENTS = 5;

const SIZE_LIMITS: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  document: 50 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

const MIME_KIND_PREFIX: [string, AttachmentKind][] = [
  ["image/", "image"],
  ["audio/", "audio"],
  ["video/", "video"],
];

/** 按 MIME 推断附件类型，未知类型当作普通文档。 */
export function kindOf(mime: string): AttachmentKind {
  for (const [prefix, kind] of MIME_KIND_PREFIX) {
    if (mime.startsWith(prefix)) return kind;
  }
  return "document";
}

export function validateFile(file: File): string | null {
  const kind = kindOf(file.type);
  if (!file.type) return "无法识别文件类型";
  if (file.size > SIZE_LIMITS[kind]) {
    return `文件过大，${kind} 上限 ${Math.round(SIZE_LIMITS[kind] / 1024 / 1024)}MB`;
  }
  return null;
}

async function jsonOrThrow(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}

/** 上传一个文件并返回登记好的附件（此时可能仍在解析）。 */
export async function uploadAttachment(file: File): Promise<Attachment> {
  const signResponse = await fetch("/uploads/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      mime: file.type,
      size: file.size,
      kind: kindOf(file.type),
    }),
  });
  const signed = await jsonOrThrow(signResponse);

  const put = await fetch(signed.uploadUrl, {
    method: signed.method ?? "PUT",
    headers: signed.headers,
    body: file,
  });
  if (!put.ok) throw new Error(`上传失败（${put.status}）`);

  const completeResponse = await fetch("/uploads/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: signed.id }),
  });
  const completed = await jsonOrThrow(completeResponse);
  return completed.attachment as Attachment;
}

/** 轮询解析状态，直到 ready / failed / skipped 或超时。 */
export async function waitForParse(
  id: string,
  timeoutMs = 90_000,
): Promise<Attachment> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`/uploads/${id}`);
    const data = await jsonOrThrow(response);
    const attachment = data.attachment as Attachment;
    const status = attachment.parse?.status;
    if (status && status !== "pending" && status !== "running") {
      return attachment;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error("解析超时");
}

/** 放弃一个附件（上传失败或用户移除时调用）。 */
export async function discardAttachment(id: string): Promise<void> {
  await fetch("/uploads/discard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch(() => undefined);
}
