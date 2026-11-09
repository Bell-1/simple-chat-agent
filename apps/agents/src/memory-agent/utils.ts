import { BaseStore, LangGraphRunnableConfig } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

/**
 * 去掉 "provider/" 前缀，只保留模型名。
 * 例如 "openai/gpt-4o" -> "gpt-4o"，"gpt-4o" -> "gpt-4o"。
 */
function parseModelName(fullySpecifiedName: string): string {
  const index = fullySpecifiedName.indexOf("/");
  return index === -1 ? fullySpecifiedName : fullySpecifiedName.slice(index + 1);
}

/**
 * Load a chat model backed by an OpenAI-compatible endpoint.
 * @param fullySpecifiedName - String in the format 'openai/model' or 'model'.
 * @returns A ChatOpenAI instance using the custom baseURL / apiKey from env.
 */
export async function loadChatModel(
  fullySpecifiedName: string,
): Promise<ChatOpenAI> {
  const apiKey = process.env.OPENAI_API_KEY;
  // 优先使用标准变量 OPENAI_BASE_URL，兼容旧的 OPENAI_API_BASE
  const baseURL = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE;

  return new ChatOpenAI({
    model: parseModelName(fullySpecifiedName),
    apiKey,
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}

/**
 * Get the store from the configuration or throw an error.
 */
export function getStoreFromConfigOrThrow(
  config: LangGraphRunnableConfig,
): BaseStore {
  if (!config.store) {
    throw new Error("Store not found in configuration");
  }

  return config.store;
}

/**
 * Split the fully specified model name into model and provider.
 */
export function splitModelAndProvider(fullySpecifiedName: string): {
  model: string;
  provider?: string;
} {
  let provider: string | undefined;
  let model: string;

  if (fullySpecifiedName.includes("/")) {
    [provider, model] = fullySpecifiedName.split("/", 2);
  } else {
    model = fullySpecifiedName;
  }

  return { model, provider };
}
