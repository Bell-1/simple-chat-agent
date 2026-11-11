import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachmentKind } from "./types.js";

/**
 * 对象存储驱动。
 *
 * 配置了 S3_BUCKET 时用 S3/OSS 兼容的签名直传；未配置时落本地磁盘，
 * 便于没有云凭证时也能完整跑通上传流程。
 */
export interface UploadTarget {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresIn: number;
}

export interface StoredObjectInfo {
  size: number;
  contentType?: string;
}

export interface StorageDriver {
  name: "s3" | "r2" | "local";
  createUploadTarget(
    key: string,
    mime: string,
  ): Promise<UploadTarget>;
  stat(key: string): Promise<StoredObjectInfo | null>;
  getUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  /** 读取对象内容，供解析管线使用 */
  readObject(key: string): Promise<Buffer>;
  /** 写入解析结果等派生文件 */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
}

const LOCAL_ROOT = fileURLToPath(
  new URL("../../.data/uploads/objects", import.meta.url),
);

function localPath(key: string): string {
  // 防目录穿越：key 由服务端生成，这里再兜一层
  const safe = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(LOCAL_ROOT, safe);
}

const localDriver: StorageDriver = {
  name: "local",

  async createUploadTarget(key) {
    return {
      url: `/uploads/local/${key}`,
      method: "PUT",
      headers: {},
      expiresIn: 900,
    };
  },

  async stat(key) {
    try {
      const info = await stat(localPath(key));
      return { size: info.size };
    } catch {
      return null;
    }
  },

  async getUrl(key) {
    return `/uploads/local/${key}`;
  },

  async delete(key) {
    await unlink(localPath(key)).catch(() => undefined);
  },

  async readObject(key) {
    return readFile(localPath(key));
  },

  async putObject(key, body) {
    const file = localPath(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  },
};

/** 本地驱动的写入与读取，只在校验通过后由 HTTP 层调用。 */
export async function writeLocalObject(
  key: string,
  body: Buffer,
): Promise<void> {
  const file = localPath(key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
}

export function readLocalObject(key: string) {
  return createReadStream(localPath(key));
}

/** 本地对象的绝对路径，供 HTTP 层读取大小等元信息。 */
export function localObjectPath(key: string): string {
  return localPath(key);
}

interface ObjectStorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** 公开访问域名，配置后返回稳定的公开 URL（否则用预签名 URL） */
  publicBaseUrl?: string;
  driver: "r2" | "s3";
}

/**
 * 解析对象存储配置：优先 Cloudflare R2（R2_*），其次通用 S3（S3_*）。
 * 都没配置时返回 null，由调用方退化为本地磁盘。
 */
function resolveObjectStorage(): ObjectStorageConfig | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const r2Endpoint =
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const bucket = process.env.R2_BUCKET || process.env.S3_BUCKET;
  if (!bucket) return null;

  const isR2 = !!r2Endpoint || !!process.env.R2_BUCKET;
  const accessKeyId =
    process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;

  return {
    bucket,
    driver: isR2 ? "r2" : "s3",
    region:
      process.env.R2_REGION ||
      process.env.S3_REGION ||
      (isR2 ? "auto" : "us-east-1"),
    endpoint: r2Endpoint || process.env.S3_ENDPOINT || undefined,
    forcePathStyle:
      process.env.S3_FORCE_PATH_STYLE === "true" ||
      (isR2 && process.env.S3_FORCE_PATH_STYLE !== "false"),
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.replace(/\/+$/, ""),
  };
}

async function createS3Driver(
  config: ObjectStorageConfig,
): Promise<StorageDriver> {
  const { S3Client, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand } =
    await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");

  const bucket = config.bucket;
  // 预签名有效期：R2/S3 上限 7 天
  const urlExpires = Number(process.env.UPLOAD_URL_EXPIRES || 604800);
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
  });

  return {
    name: config.driver,

    async createUploadTarget(key, mime) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: mime,
        }),
        { expiresIn: 900 },
      );
      return {
        url,
        method: "PUT",
        headers: { "Content-Type": mime },
        expiresIn: 900,
      };
    },

    async stat(key) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return { size: head.ContentLength ?? 0, contentType: head.ContentType };
      } catch {
        return null;
      }
    },

    async getUrl(key) {
      // 配置了公开域名时返回稳定地址，否则退化为有时效的预签名地址
      if (config.publicBaseUrl) return `${config.publicBaseUrl}/${key}`;
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: urlExpires },
      );
    },

    async delete(key) {
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        .catch(() => undefined);
    },

    async readObject(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      return Buffer.from(bytes ?? new Uint8Array());
    },

    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
  };
}

let driverPromise: Promise<StorageDriver> | null = null;

export function getStorageDriver(): Promise<StorageDriver> {
  if (!driverPromise) {
    const config = resolveObjectStorage();
    driverPromise = config
      ? createS3Driver(config)
      : Promise.resolve(localDriver);
  }
  return driverPromise;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};

/** 生成对象 key：图片放 images/，其余附件放 files/，便于按类型分目录。 */
export function buildObjectKey(
  kind: AttachmentKind,
  id: string,
  name: string,
  mime: string,
): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const fromName = extname(name).toLowerCase();
  const ext = /^\.[a-z0-9]{1,8}$/.test(fromName)
    ? fromName
    : (EXTENSION_BY_MIME[mime] ?? "");
  const prefix = kind === "image" ? "images" : "files";
  return `${prefix}/${year}/${month}/${id}${ext}`;
}

/** 从 key 的最后一段反解附件 id（去掉扩展名）。 */
export function idFromObjectKey(key: string): string {
  const base = key.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 解析文本的存储 key，与原始对象分开存放。 */
export function parsedTextKey(id: string): string {
  return `parsed/${id}.txt`;
}
