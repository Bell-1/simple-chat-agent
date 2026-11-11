import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 模型能力配置（网关视觉能力）。
 *
 * 单一配置来源是仓库根目录的 model-capabilities.json，前后端共用：
 * 解析优先级为 models 精确匹配 > 网关 /models 的 input_modalities > patterns > defaults。
 * 前端只能读静态配置，后端还能额外读取网关声明的模态，两者结论一致。
 */
export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  source: "config" | "gateway" | "pattern" | "default";
}

interface PartialCapabilities {
  vision?: boolean;
  audio?: boolean;
}

interface CapabilityConfig {
  useGatewayMetadata?: boolean;
  defaults?: PartialCapabilities;
  models?: Record<string, PartialCapabilities>;
  patterns?: { match: string; vision?: boolean; audio?: boolean }[];
}

const CONFIG_CANDIDATES = [
  process.env.MODEL_CAPABILITIES_FILE,
  fileURLToPath(new URL("../../../../model-capabilities.json", import.meta.url)),
  // langgraph dev / 生产进程的 cwd 可能是 apps/agents 或仓库根目录
  resolve(process.cwd(), "../../model-capabilities.json"),
  resolve(process.cwd(), "model-capabilities.json"),
].filter((item): item is string => !!item);

function loadConfig(): CapabilityConfig {
  for (const file of CONFIG_CANDIDATES) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as CapabilityConfig;
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return {};
}

const config = loadConfig();

/** 只看本地配置，不发网络请求，用于同步场景。 */
export function getConfiguredCapabilities(model: string): ModelCapabilities {
  const exact = config.models?.[model];
  if (exact) {
    return {
      vision: exact.vision ?? false,
      audio: exact.audio ?? false,
      source: "config",
    };
  }

  for (const rule of config.patterns ?? []) {
    let matched = false;
    try {
      matched = new RegExp(rule.match, "i").test(model);
    } catch {
      continue;
    }
    if (!matched) continue;
    return {
      vision: rule.vision ?? config.defaults?.vision ?? false,
      audio: rule.audio ?? config.defaults?.audio ?? false,
      source: "pattern",
    };
  }

  return {
    vision: config.defaults?.vision ?? false,
    audio: config.defaults?.audio ?? false,
    source: "default",
  };
}

/** 网关 /models 返回的模态信息，缓存 10 分钟；网关不提供时返回空。 */
const GATEWAY_TTL_MS = 10 * 60 * 1000;
let gatewayCache: { at: number; modalities: Map<string, string[]> } | null =
  null;

async function fetchGatewayModalities(): Promise<Map<string, string[]>> {
  if (gatewayCache && Date.now() - gatewayCache.at < GATEWAY_TTL_MS) {
    return gatewayCache.modalities;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE;
  const modalities = new Map<string, string[]>();
  if (!apiKey || !baseURL) return modalities;

  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return modalities;

    const data = (await response.json()) as {
      data?: { id?: string; input_modalities?: string[] }[];
    };
    for (const item of data.data ?? []) {
      if (item.id && item.input_modalities?.length) {
        modalities.set(item.id, item.input_modalities);
      }
    }
  } catch {
    // 网络异常时退化为本地配置，不影响对话主流程
    return modalities;
  }

  gatewayCache = { at: Date.now(), modalities };
  return modalities;
}

/** 完整解析：本地精确配置优先，其次网关模态，再退化为模式与默认值。 */
export async function getModelCapabilities(
  model: string,
): Promise<ModelCapabilities> {
  if (config.models?.[model]) return getConfiguredCapabilities(model);

  if (config.useGatewayMetadata !== false) {
    const modalities = await fetchGatewayModalities();
    const declared = modalities.get(model);
    if (declared?.length) {
      return {
        vision: declared.includes("image"),
        audio: declared.includes("audio"),
        source: "gateway",
      };
    }
  }

  return getConfiguredCapabilities(model);
}
