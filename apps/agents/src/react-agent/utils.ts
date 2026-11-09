import { AIMessage } from "@langchain/core/messages";
import {
  ChatOpenAI,
  ChatOpenAICompletions,
  type ChatOpenAIFields,
} from "@langchain/openai";

/**
 * 去掉 "provider/" 前缀，只保留模型名。
 * 例如 "openai/gpt-4o" -> "gpt-4o"，"gpt-4o" -> "gpt-4o"。
 */
function parseModelName(fullySpecifiedName: string): string {
  const index = fullySpecifiedName.indexOf("/");
  return index === -1 ? fullySpecifiedName : fullySpecifiedName.slice(index + 1);
}

/**
 * ChatOpenAI 默认会丢弃 OpenAI 兼容网关返回的 `reasoning_content`，
 * 这里重写 completions 消息转换方法，把它转存到
 * `additional_kwargs.reasoning_content`，供前端渲染「思考过程」。
 *
 * 注意：LangChain v1 的 ChatOpenAI 采用组合模式，转换逻辑在
 * ChatOpenAICompletions 上，所以需要继承它并通过 `completions` 字段注入。
 */
class ReasoningChatOpenAICompletions extends ChatOpenAICompletions {
  protected _convertCompletionsMessageToBaseMessage(
    message: any,
    rawResponse: any,
  ): any {
    const base = super._convertCompletionsMessageToBaseMessage(
      message,
      rawResponse,
    );
    const reasoning = message?.reasoning_content;
    if (base && typeof reasoning === "string" && reasoning.trim()) {
      (base.additional_kwargs as Record<string, any>).reasoning_content =
        reasoning;
    }
    return base;
  }

  protected _convertCompletionsDeltaToBaseMessageChunk(
    delta: any,
    rawResponse: any,
    defaultRole?: any,
  ): any {
    const chunk = super._convertCompletionsDeltaToBaseMessageChunk(
      delta,
      rawResponse,
      defaultRole,
    );
    const reasoning = delta?.reasoning_content;
    if (chunk && typeof reasoning === "string" && reasoning) {
      (chunk.additional_kwargs as Record<string, any>).reasoning_content =
        reasoning;
    }
    return chunk;
  }
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

  const fields = {
    model: parseModelName(fullySpecifiedName),
    apiKey,
    ...(baseURL ? { configuration: { baseURL } } : {}),
  } satisfies ChatOpenAIFields;

  return new ChatOpenAI({
    ...fields,
    // 让 ChatOpenAI 的 withConfig 等派生实例也保留推理内容转换
    completions: new ReasoningChatOpenAICompletions(fields),
  });
}

/**
 * 兼容兜底：若网关把 reasoning_content 只放在原始响应里，则转存后再移除原始响应。
 */
export function attachReasoning(message: AIMessage): AIMessage {
  const additional = message.additional_kwargs as Record<string, any>;
  const raw = additional?.__raw_response;
  if (raw) {
    const reasoning = raw?.choices?.[0]?.message?.reasoning_content;
    if (
      !additional.reasoning_content &&
      typeof reasoning === "string" &&
      reasoning.trim()
    ) {
      additional.reasoning_content = reasoning;
    }
    delete additional.__raw_response;
  }

  return message;
}
