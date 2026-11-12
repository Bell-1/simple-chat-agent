/** 认证接口客户端：与上传服务同域，通过 Vite 代理 /api 访问。 */

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

interface AuthResponse {
  user: AuthUser;
}

class AuthRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthRequestError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : `请求失败（${response.status}）`;
    throw new AuthRequestError(message, response.status);
  }
  return data as T;
}

/** 读取当前登录用户；未登录时返回 null。 */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const data = await request<AuthResponse>("/api/auth/me");
    return data.user;
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 401) return null;
    throw error;
  }
}

export async function login(input: {
  email: string;
  password: string;
}): Promise<AuthUser> {
  const data = await request<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.user;
}

export async function register(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<AuthUser> {
  const data = await request<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.user;
}

export async function logout(): Promise<void> {
  await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}
