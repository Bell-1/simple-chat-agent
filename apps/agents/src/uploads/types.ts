/**
 * 附件上传的共享类型与限制。
 *
 * 图片走「原图直传」，文档/音视频后续由解析管线处理；
 * 这里只负责把二进制安全地放进对象存储，并登记元数据。
 */
export type AttachmentKind = "image" | "document" | "audio" | "video";

/** 解析状态：图片直接 skipped，其余异步解析。 */
export interface ParseState {
  status: "pending" | "running" | "ready" | "failed" | "skipped";
  /** 抽取/转写出的纯文本字符数 */
  chars?: number;
  /** 文档页数（PDF/Word） */
  pages?: number;
  /** 是否因超长被截断 */
  truncated?: boolean;
  error?: string;
  updatedAt?: string;
}

export interface AttachmentRecord {
  id: string;
  /** 对象存储的 key（本地驱动下同时是磁盘相对路径） */
  key: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  status: "pending" | "ready";
  createdAt: string;
  /** 上传者 id，用于归属与后续按用户检索 */
  userId?: string;
  parse?: ParseState;
}

/** 解析文本的字符上限，超出部分截断（约 2 万 token）。 */
export const MAX_PARSED_CHARS = 60_000;

export const MAX_ATTACHMENT_COUNT = 5;

export const SIZE_LIMITS: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  document: 50 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

export const MIME_WHITELIST: Record<AttachmentKind, string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/markdown",
    "text/csv",
  ],
  audio: ["audio/mpeg", "audio/wav", "audio/mp4", "audio/webm"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
};

/** 校验请求参数，返回错误信息；通过时返回 null。 */
export function validateUploadInput(input: {
  kind?: unknown;
  mime?: unknown;
  size?: unknown;
}): string | null {
  const kind = input.kind;
  if (kind !== "image" && kind !== "document" && kind !== "audio" && kind !== "video") {
    return "kind 必须是 image / document / audio / video";
  }
  const mime = input.mime;
  if (typeof mime !== "string" || !MIME_WHITELIST[kind].includes(mime)) {
    return `不支持的文件类型：${String(mime)}`;
  }
  const size = input.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return "size 必须是正数";
  }
  if (size > SIZE_LIMITS[kind]) {
    return `文件过大，${kind} 上限 ${Math.round(SIZE_LIMITS[kind] / 1024 / 1024)}MB`;
  }
  return null;
}
