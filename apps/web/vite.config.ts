import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // 读取仓库根目录的 .env，供 /openai 代理转发使用
  const env = loadEnv(mode, path.resolve(__dirname, "../.."), "");
  const openaiBase =
    env.OPENAI_BASE_URL || env.OPENAI_API_BASE || "https://api.deepseek.com";
  const openaiKey = env.OPENAI_API_KEY || "";
  const basePath = new URL(openaiBase).pathname.replace(/\/$/, "");

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: {
        // 前端通过 /openai/* 访问 OpenAI 兼容接口（模型列表等），避免暴露 API Key
        "/openai": {
          target: openaiBase,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/openai/, basePath),
          headers: openaiKey
            ? { Authorization: `Bearer ${openaiKey}` }
            : undefined,
        },
        // 附件上传服务（apps/agents/src/uploads/server.ts）
        "/uploads": {
          target: `http://localhost:${env.UPLOAD_PORT || "2025"}`,
          changeOrigin: true,
        },
        // 认证接口与上传服务同进程，复用 Cookie 会话
        "/api": {
          target: `http://localhost:${env.UPLOAD_PORT || "2025"}`,
          changeOrigin: true,
        },
        // LangGraph 服务统一走同源代理，前端无需再配置 VITE_API_URL
        "/lg": {
          target: `http://localhost:${env.LANGGRAPH_PORT || "2024"}`,
          rewrite: (path) => path.replace(/^\/lg/, ""),
          changeOrigin: true,
        },
      },
    },
  };
});
