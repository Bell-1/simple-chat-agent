import { BaseMessage } from "@langchain/core/messages";
import { Document } from "@langchain/core/documents";

import { ChatOpenAI } from "@langchain/openai";

export function getMessageText(msg: BaseMessage): string {
  /** Get the text content of a message. */
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txts = (content as any[]).map((c) =>
      typeof c === "string" ? c : c.text || "",
    );
    return txts.join("").trim();
  }
}

export function formatDoc(doc: Document): string {
  const metadata = doc.metadata || {};
  const meta = Object.entries(metadata)
    .map(([k, v]) => ` ${k}=${v}`)
    .join("");
  const metaStr = meta ? ` ${meta}` : "";

  return `<document${metaStr}>\n${doc.pageContent}\n</document>`;
}

export function formatDocs(docs?: Document[]): string {
  /**Format a list of documents as XML. */
  if (!docs || docs.length === 0) {
    return "<documents></documents>";
  }
  const formatted = docs.map(formatDoc).join("\n");
  return `<documents>\n${formatted}\n</documents>`;
}

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
