import { create } from "zustand";
import {
  fetchCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
  type AuthUser,
} from "@/lib/auth";

interface AuthState {
  user: AuthUser | null;
  /** 首次会话检查是否完成 */
  initialized: boolean;
  /** 登录/注册请求进行中 */
  submitting: boolean;
  fetchMe: () => Promise<void>;
  login: (input: { email: string; password: string }) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * 认证状态。
 * 会话本身是 HttpOnly Cookie，这里只缓存用户信息用于渲染，不做持久化。
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  initialized: false,
  submitting: false,

  fetchMe: async () => {
    try {
      const user = await fetchCurrentUser();
      set({ user, initialized: true });
    } catch {
      set({ user: null, initialized: true });
    }
  },

  login: async (input) => {
    set({ submitting: true });
    try {
      const user = await loginRequest(input);
      set({ user });
    } finally {
      set({ submitting: false });
    }
  },

  register: async (input) => {
    set({ submitting: true });
    try {
      const user = await registerRequest(input);
      set({ user });
    } finally {
      set({ submitting: false });
    }
  },

  logout: async () => {
    await logoutRequest().catch(() => undefined);
    set({ user: null });
  },
}));
