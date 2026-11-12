import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * 用户与会话存储。
 *
 * 与长期记忆一样先用本地 JSON 落地，零外部依赖、便于本地开发；
 * 生产环境可把 readAll / mutate 换成 Postgres 或 MongoDB 实现。
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
}

interface SessionRecord {
  tokenHash: string;
  userId: string;
  expiresAt: number;
}

interface AuthFile {
  users: UserRecord[];
  sessions: SessionRecord[];
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

const DATA_FILE = fileURLToPath(
  new URL("../../.data/auth.json", import.meta.url),
);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KEY_LENGTH = 64;

let writeChain: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<AuthFile> {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, "utf8")) as AuthFile;
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { users: [], sessions: [] };
  }
}

async function mutate<T>(fn: (data: AuthFile) => T | Promise<T>): Promise<T> {
  const run = async () => {
    const data = await readAll();
    const result = await fn(data);
    await mkdir(dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
    return result;
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return derived.toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}

export function validateCredentials(input: {
  email?: string;
  password?: string;
  name?: string;
}): string | null {
  const email = normalizeEmail(input.email ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "请输入有效的邮箱地址";
  if ((input.password ?? "").length < 6) return "密码至少 6 位";
  if (input.name !== undefined && input.name.trim().length > 30) {
    return "昵称不能超过 30 个字符";
  }
  return null;
}

export async function registerUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ user: PublicUser; token: string }> {
  const email = normalizeEmail(input.email);
  const name = (input.name ?? "").trim() || email.split("@")[0];

  return mutate(async (data) => {
    if (data.users.some((user) => user.email === email)) {
      throw new Error("该邮箱已注册");
    }
    const salt = randomBytes(16).toString("hex");
    const user: UserRecord = {
      id: randomUUID(),
      email,
      name,
      salt,
      passwordHash: await hashPassword(input.password, salt),
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    const token = issueSession(data, user.id);
    return { user: toPublicUser(user), token };
  });
}

export async function loginUser(input: {
  email: string;
  password: string;
}): Promise<{ user: PublicUser; token: string }> {
  const email = normalizeEmail(input.email);
  const data = await readAll();
  const user = data.users.find((item) => item.email === email);
  if (!user) throw new Error("邮箱或密码错误");

  const candidate = await hashPassword(input.password, user.salt);
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(candidate, "hex");
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error("邮箱或密码错误");
  }

  return mutate((next) => {
    const token = issueSession(next, user.id);
    return { user: toPublicUser(user), token };
  });
}

/** 生成会话 token，只把哈希写入磁盘。 */
function issueSession(data: AuthFile, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  data.sessions = data.sessions.filter((item) => item.expiresAt > now);
  data.sessions.push({
    tokenHash: hashToken(token),
    userId,
    expiresAt: now + SESSION_TTL_MS,
  });
  return token;
}

export async function getSessionUser(token: string): Promise<PublicUser | null> {
  if (!token) return null;
  const data = await readAll();
  const session = data.sessions.find((item) => item.tokenHash === hashToken(token));
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = data.users.find((item) => item.id === session.userId);
  return user ? toPublicUser(user) : null;
}

export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  await mutate((data) => {
    data.sessions = data.sessions.filter((item) => item.tokenHash !== tokenHash);
  });
}

export const SESSION_COOKIE = "chat_session";
export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
