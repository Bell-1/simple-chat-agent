import config from "../../../../model-capabilities.json";

/**
 * 模型能力：决定前端能否提供图片/音频入口，以及后端如何构造请求。
 *
 * 解析优先级：models 精确匹配 > 网关 /models 的 input_modalities > patterns > defaults。
 * 网关若不返回模态信息（useGatewayMetadata=false 或字段缺失），则退化为本地规则。
 */
export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  /** 能力的来源，便于在界面上说明为什么可用/不可用 */
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

const capabilityConfig = config as unknown as CapabilityConfig;

function pick(
  value: PartialCapabilities | undefined,
  source: ModelCapabilities["source"],
  fallback?: PartialCapabilities,
): ModelCapabilities | undefined {
  if (!value) return undefined;
  return {
    vision: value.vision ?? fallback?.vision ?? false,
    audio: value.audio ?? fallback?.audio ?? false,
    source,
  };
}

/**
 * @param model 模型 id（通常来自网关的 /models）
 * @param gatewayModalities 网关返回的 input_modalities，例如 ["text", "image"]
 */
export function resolveModelCapabilities(
  model: string,
  gatewayModalities?: string[],
): ModelCapabilities {
  const exact = pick(capabilityConfig.models?.[model], "config");
  if (exact) return exact;

  if (
    capabilityConfig.useGatewayMetadata !== false &&
    gatewayModalities &&
    gatewayModalities.length > 0
  ) {
    return {
      vision: gatewayModalities.includes("image"),
      audio: gatewayModalities.includes("audio"),
      source: "gateway",
    };
  }

  for (const rule of capabilityConfig.patterns ?? []) {
    let matched = false;
    try {
      matched = new RegExp(rule.match, "i").test(model);
    } catch {
      // 配置里的正则写错时忽略该条规则，不影响其它规则
      continue;
    }
    if (!matched) continue;
    return {
      vision: rule.vision ?? capabilityConfig.defaults?.vision ?? false,
      audio: rule.audio ?? capabilityConfig.defaults?.audio ?? false,
      source: "pattern",
    };
  }

  return {
    vision: capabilityConfig.defaults?.vision ?? false,
    audio: capabilityConfig.defaults?.audio ?? false,
    source: "default",
  };
}
