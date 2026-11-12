/**
 * Embedding 客户端。
 *
 * 优先使用 OpenAI 兼容接口（EMBEDDING_BASE_URL + EMBEDDING_API_KEY）；
 * 未配置时退回本机 Ollama（默认 bge-m3），方便本地开发零密钥运行。
 */

export interface EmbeddingConfig {
  provider: "openai" | "ollama";
  baseUrl: string;
  apiKey?: string;
  model: string;
}

const BATCH_SIZE = 16;
const MAX_RETRIES = 2;
const TIMEOUT_MS = 60_000;

export function resolveEmbeddingConfig(): EmbeddingConfig {
  const baseUrl = process.env.EMBEDDING_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (baseUrl && apiKey) {
    return {
      provider: "openai",
      baseUrl,
      apiKey,
      model: process.env.EMBEDDING_MODEL || "BAAI/bge-m3",
    };
  }
  return {
    provider: "ollama",
    baseUrl: (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(
      /\/+$/,
      "",
    ),
    model: process.env.EMBEDDING_MODEL || "bge-m3",
  };
}

async function embedBatch(
  inputs: string[],
  config: EmbeddingConfig,
): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response =
      config.provider === "openai"
        ? await fetch(`${config.baseUrl}/embeddings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({ model: config.model, input: inputs }),
            signal: controller.signal,
          })
        : await fetch(`${config.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: config.model, input: inputs }),
            signal: controller.signal,
          });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Embedding 请求失败（${response.status}）：${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      data?: { embedding: number[] }[];
      embeddings?: number[][];
    };
    if (Array.isArray(data.embeddings)) return data.embeddings;
    if (Array.isArray(data.data)) {
      return data.data.map((item) => item.embedding);
    }
    throw new Error("Embedding 响应格式无法识别");
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const config = resolveEmbeddingConfig();
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await withRetry(() => embedBatch(batch, config));
    if (result.length !== batch.length) {
      throw new Error("Embedding 返回数量与输入不一致");
    }
    vectors.push(...result);
  }
  return vectors;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  if (!vector) throw new Error("Embedding 返回为空");
  return vector;
}

/** 把向量序列化为 pgvector 字面量。 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value.toFixed(6))).join(",")}]`;
}
