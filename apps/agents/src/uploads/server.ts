import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import {
  deleteRecord,
  getRecord,
  listRecordsByUser,
  saveRecord,
} from "./metadata.js";
import {
  buildObjectKey,
  getStorageDriver,
  idFromObjectKey,
  localObjectPath,
  parsedTextKey,
  readLocalObject,
  writeLocalObject,
} from "./storage.js";
import { parseAttachment } from "./parse/index.js";
import {
  MAX_PARSED_CHARS,
  SIZE_LIMITS,
  validateUploadInput,
  type AttachmentKind,
  type AttachmentRecord,
  type ParseState,
} from "./types.js";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  deleteSession,
  getSessionUser,
  loginUser,
  registerUser,
  validateCredentials,
} from "../auth/store.js";
import { indexAttachment, removeAttachmentIndex } from "../rag/ingest.js";
import { getLibraryStats } from "../rag/search.js";

/**
 * 附件上传服务（独立进程，默认 2025 端口）。
 *
 * 只做三件事：签发直传地址、确认上传结果、提供本地驱动的读写回退。
 * 不参与对话图执行，避免把存储凭证和二进制流塞进 langgraph 运行时。
 */
// 独立进程不经过 langgraph 的环境加载，这里显式读取仓库根目录的 .env
loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

const PORT = Number(process.env.UPLOAD_PORT || 2025);
/** 设置后所有请求都必须携带 Authorization: Bearer <token> */
const TOKEN = process.env.UPLOAD_TOKEN;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new Error("请求体过大");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req, 1024 * 1024);
  if (!body.length) return {} as T;
  return JSON.parse(body.toString("utf8")) as T;
}

function authorized(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

/** 从 Cookie 头中读取指定字段。 */
function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function sessionToken(req: IncomingMessage): string {
  return readCookie(req, SESSION_COOKIE) ?? "";
}

async function currentUser(req: IncomingMessage) {
  return getSessionUser(sessionToken(req));
}

function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

/** 注册：创建用户并直接签发会话。 */
async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const input = await readJson<{
    email?: string;
    password?: string;
    name?: string;
  }>(req);
  const invalid = validateCredentials(input);
  if (invalid) return json(res, 400, { error: invalid });

  try {
    const { user, token } = await registerUser({
      email: input.email ?? "",
      password: input.password ?? "",
      name: input.name,
    });
    setSessionCookie(res, token);
    return json(res, 200, { user });
  } catch (error) {
    const message = error instanceof Error ? error.message : "注册失败";
    return json(res, 409, { error: message });
  }
}

/** 登录：校验密码后签发会话。 */
async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const input = await readJson<{ email?: string; password?: string }>(req);
  const invalid = validateCredentials(input);
  if (invalid) return json(res, 400, { error: invalid });

  try {
    const { user, token } = await loginUser({
      email: input.email ?? "",
      password: input.password ?? "",
    });
    setSessionCookie(res, token);
    return json(res, 200, { user });
  } catch (error) {
    const message = error instanceof Error ? error.message : "登录失败";
    return json(res, 401, { error: message });
  }
}

async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await deleteSession(sessionToken(req));
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
}

async function handleMe(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: "未登录" });
  return json(res, 200, { user });
}

/** 签发直传地址并登记一条 pending 记录。 */
async function handleSign(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const input = await readJson<{
    name?: string;
    mime?: string;
    size?: number;
    kind?: AttachmentKind;
  }>(req);

  const invalid = validateUploadInput(input);
  if (invalid) return json(res, 400, { error: invalid });

  const kind = input.kind as AttachmentKind;
  const name = (input.name ?? "").trim() || `attachment-${Date.now()}`;
  const mime = input.mime as string;
  const size = input.size as number;

  const id = randomUUID();
  const key = buildObjectKey(kind, id, name, mime);
  // 上传入口必须登录，附件因此天然归属于当前用户
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: "请先登录" });
  const record: AttachmentRecord = {
    id,
    key,
    kind,
    name,
    mime,
    size,
    status: "pending",
    createdAt: new Date().toISOString(),
    userId: user.id,
  };

  const driver = await getStorageDriver();
  const target = await driver.createUploadTarget(key, mime);
  await saveRecord(record);

  return json(res, 200, {
    id,
    key,
    uploadUrl: target.url,
    method: target.method,
    headers: target.headers,
    expiresIn: target.expiresIn,
    driver: driver.name,
  });
}

/** 上传完成后核对对象真实大小与类型，再置为 ready。 */
async function handleComplete(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { id } = await readJson<{ id?: string }>(req);
  if (!id) return json(res, 400, { error: "缺少 id" });

  const record = await getRecord(id);
  if (!record) return json(res, 404, { error: "附件不存在" });

  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: "请先登录" });
  if (record.userId && record.userId !== user.id) {
    return json(res, 403, { error: "无权操作该附件" });
  }

  const driver = await getStorageDriver();
  const info = await driver.stat(record.key);
  if (!info) return json(res, 409, { error: "对象尚未上传完成" });

  if (info.size > SIZE_LIMITS[record.kind]) {
    await driver.delete(record.key);
    await deleteRecord(record.id);
    return json(res, 413, { error: "文件超过大小限制" });
  }
  if (info.contentType && !info.contentType.startsWith(record.mime)) {
    await driver.delete(record.key);
    await deleteRecord(record.id);
    return json(res, 415, { error: "文件类型与声明不一致" });
  }

  const ready: AttachmentRecord = {
    ...record,
    size: info.size || record.size,
    status: "ready",
    parse:
      record.kind === "image"
        ? { status: "skipped", updatedAt: new Date().toISOString() }
        : { status: "pending", updatedAt: new Date().toISOString() },
  };
  await saveRecord(ready);

  // 文档与音视频异步解析，不阻塞上传返回
  if (ready.kind !== "image") {
    void runParse(ready.id);
  }

  const target = await driver.getUrl(ready.key);
  return json(res, 200, {
    attachment: {
      id: ready.id,
      kind: ready.kind,
      name: ready.name,
      mime: ready.mime,
      size: ready.size,
      status: ready.status,
      parse: ready.parse,
      createdAt: ready.createdAt,
      url: target.startsWith("/") ? `http://localhost:${PORT}${target}` : target,
    },
  });
}

/** 读取对象 → 抽取文本 → 落盘解析结果，失败只记录状态，不影响原始附件。 */
async function runParse(id: string): Promise<void> {
  const record = await getRecord(id);
  if (!record) return;

  const driver = await getStorageDriver();
  await saveRecord({ ...record, parse: { status: "running", updatedAt: new Date().toISOString() } });

  try {
    const buffer = await driver.readObject(record.key);
    const result = await parseAttachment(record, buffer);
    // 完整文本落盘供 RAG 分块；上下文注入时再按预算截断
    const text = result.text;
    if (!text) throw new Error("未解析出任何文本内容");

    await driver.putObject(
      parsedTextKey(id),
      Buffer.from(text, "utf8"),
      "text/plain; charset=utf-8",
    );

    const latest = (await getRecord(id)) ?? record;
    const parse: ParseState = {
      status: "ready",
      chars: text.length,
      pages: result.pages,
      truncated: text.length > MAX_PARSED_CHARS,
      updatedAt: new Date().toISOString(),
    };
    await saveRecord({ ...latest, parse });

    // 向量化在后台进行，不阻塞附件 ready；失败不影响附件本身可用
    void indexAttachment({ ...latest, parse }, text).catch((error: unknown) => {
      console.warn(`[rag] 附件 ${id} 索引失败`, error);
    });
  } catch (error) {
    const latest = (await getRecord(id)) ?? record;
    const parse: ParseState = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
    await saveRecord({ ...latest, parse });
  }
}

/** 查询附件状态；顺带返回可访问 URL 与解析进度。 */
async function handleGet(
  res: ServerResponse,
  id: string,
): Promise<void> {
  const record = await getRecord(id);
  if (!record) return json(res, 404, { error: "附件不存在" });

  const driver = await getStorageDriver();
  const url = await driver.getUrl(record.key);
  return json(res, 200, {
    attachment: {
      id: record.id,
      kind: record.kind,
      name: record.name,
      mime: record.mime,
      size: record.size,
      status: record.status,
      parse: record.parse,
      createdAt: record.createdAt,
      url: url.startsWith("/") ? `http://localhost:${PORT}${url}` : url,
    },
  });
}

/** 供对话图读取原始二进制（图片转 data URL 用）。 */
async function handleGetContent(
  res: ServerResponse,
  id: string,
): Promise<void> {
  const record = await getRecord(id);
  if (!record) return json(res, 404, { error: "附件不存在" });

  const driver = await getStorageDriver();
  const buffer = await driver.readObject(record.key);
  res.writeHead(200, {
    "Content-Type": record.mime,
    "Content-Length": buffer.length,
  });
  res.end(buffer);
}

/** 供对话图在构造上下文时读取解析文本。 */
async function handleGetText(
  res: ServerResponse,
  id: string,
): Promise<void> {
  const record = await getRecord(id);
  if (!record) return json(res, 404, { error: "附件不存在" });
  if (record.parse?.status !== "ready") {
    return json(res, 409, {
      error: `附件尚未解析完成（${record.parse?.status ?? "pending"}）`,
    });
  }

  const driver = await getStorageDriver();
  const buffer = await driver.readObject(parsedTextKey(id));
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": buffer.length,
  });
  res.end(buffer);
}

/** 当前用户的资料库：附件列表 + 索引统计。 */
async function handleMine(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: "请先登录" });

  const records = await listRecordsByUser(user.id);
  const driver = await getStorageDriver();
  const attachments = await Promise.all(
    records.map(async (record) => {
      const url = await driver.getUrl(record.key).catch(() => "");
      return {
        id: record.id,
        kind: record.kind,
        name: record.name,
        mime: record.mime,
        size: record.size,
        createdAt: record.createdAt,
        parse: record.parse,
        url: url.startsWith("/") ? `http://localhost:${PORT}${url}` : url,
      };
    }),
  );

  let stats = { documents: 0, chunks: 0 };
  try {
    stats = await getLibraryStats(user.id);
  } catch (error) {
    console.warn("[rag] 读取资料库统计失败", error);
  }
  return json(res, 200, { attachments, stats });
}

async function handleDiscard(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { id } = await readJson<{ id?: string }>(req);
  if (!id) return json(res, 400, { error: "缺少 id" });

  const record = await getRecord(id);
  if (!record) return json(res, 200, { ok: true });

  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: "请先登录" });
  if (record.userId && record.userId !== user.id) {
    return json(res, 403, { error: "无权操作该附件" });
  }

  const driver = await getStorageDriver();
  await driver.delete(record.key);
  await driver.delete(parsedTextKey(id));
  await deleteRecord(id);
  void removeAttachmentIndex(id);
  return json(res, 200, { ok: true });
}

/** 本地驱动专用：接收直传的二进制。 */
async function handleLocalPut(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<void> {
  const record = await getRecord(idFromObjectKey(key));
  if (!record || record.key !== key) {
    return json(res, 404, { error: "附件不存在" });
  }
  if (record.status !== "pending") {
    return json(res, 409, { error: "附件已上传" });
  }

  const user = await currentUser(req);
  if (!user || (record.userId && record.userId !== user.id)) {
    return json(res, 401, { error: "请先登录" });
  }

  const body = await readBody(req, SIZE_LIMITS[record.kind]);
  if (!body.length) return json(res, 400, { error: "文件为空" });

  await writeLocalObject(key, body);
  return json(res, 200, { ok: true, size: body.length });
}

/** 本地驱动专用：读取对象（仅开发环境使用）。 */
async function handleLocalGet(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<void> {
  const record = await getRecord(idFromObjectKey(key));
  if (!record || record.key !== key) {
    return json(res, 404, { error: "附件不存在" });
  }

  const user = await currentUser(req);
  if (!user || (record.userId && record.userId !== user.id)) {
    return json(res, 401, { error: "请先登录" });
  }

  const driver = await getStorageDriver();
  if (driver.name !== "local") {
    return json(res, 404, { error: "当前使用对象存储，请访问签名地址" });
  }

  const fileStat = await stat(localObjectPath(key)).catch(() => null);
  if (!fileStat) return json(res, 404, { error: "文件不存在" });

  res.writeHead(200, {
    "Content-Type": record.mime,
    "Content-Length": fileStat.size,
  });
  readLocalObject(key).pipe(res);
}

const server = createServer((req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!authorized(req)) {
    json(res, 401, { error: "未授权" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  const run = async () => {
    if (req.method === "GET" && path === "/health") {
      const driver = await getStorageDriver();
      return json(res, 200, { ok: true, driver: driver.name });
    }
    if (req.method === "POST" && path === "/api/auth/register") {
      return handleRegister(req, res);
    }
    if (req.method === "POST" && path === "/api/auth/login") {
      return handleLogin(req, res);
    }
    if (req.method === "POST" && path === "/api/auth/logout") {
      return handleLogout(req, res);
    }
    if (req.method === "GET" && path === "/api/auth/me") {
      return handleMe(req, res);
    }
    if (req.method === "GET" && path === "/uploads/mine") {
      return handleMine(req, res);
    }
    if (req.method === "POST" && path === "/uploads/sign") {
      return handleSign(req, res);
    }
    if (req.method === "POST" && path === "/uploads/complete") {
      return handleComplete(req, res);
    }
    if (req.method === "POST" && path === "/uploads/discard") {
      return handleDiscard(req, res);
    }
    if (path.startsWith("/uploads/local/")) {
      const key = path.slice("/uploads/local/".length);
      if (req.method === "PUT") return handleLocalPut(req, res, key);
      if (req.method === "GET") return handleLocalGet(req, res, key);
    }
    // GET /uploads/<id> 查询状态；/text 读解析文本；/content 读原始二进制
    const uploadMatch = /^\/uploads\/([0-9a-f-]{36})(\/text|\/content)?$/.exec(
      path,
    );
    if (req.method === "GET" && uploadMatch) {
      if (uploadMatch[2] === "/text") {
        return handleGetText(res, uploadMatch[1]);
      }
      if (uploadMatch[2] === "/content") {
        return handleGetContent(res, uploadMatch[1]);
      }
      return handleGet(res, uploadMatch[1]);
    }
    return json(res, 404, { error: "未找到路由" });
  };

  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    json(res, message === "请求体过大" ? 413 : 500, { error: message });
  });
});

server.listen(PORT, () => {
  console.log(`[uploads] listening on http://localhost:${PORT}`);
});
