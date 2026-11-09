import { Message } from "@langchain/langgraph-sdk";
import { BrainCircuit, LoaderCircle } from "lucide-react";
import { CollapsiblePanel } from "./collapsible";

const REASONING_KEYS = [
  "reasoning_content",
  "reasoning",
  "thinking",
  "analysis",
] as const;

/** 从多种兼容格式中提取思考内容（DeepSeek reasoning_content / Anthropic thinking 块等）。 */
export function getReasoningString(message: Message | undefined): string {
  if (!message) return "";

  const raw = message as Record<string, any>;
  const additional = (raw.additional_kwargs ?? {}) as Record<string, any>;
  for (const key of REASONING_KEYS) {
    const value = additional[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    // OpenAI Responses API 的 reasoning item 结构
    if (value && typeof value === "object" && typeof value.summary === "string") {
      return value.summary.trim();
    }
  }

  const metadata = (raw.response_metadata ?? {}) as Record<string, any>;
  for (const key of REASONING_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  if (Array.isArray(raw.content)) {
    const blocks = (raw.content as Array<Record<string, any>>)
      .filter((block) => block?.type === "thinking")
      .map((block) => block.thinking ?? block.text ?? "")
      .filter((text): text is string => typeof text === "string" && !!text);
    if (blocks.length > 0) return blocks.join("\n").trim();
  }

  return "";
}

export function ReasoningPanel({
  reasoning,
  isStreaming,
}: {
  reasoning: string;
  isStreaming: boolean;
}) {
  if (!reasoning) return null;

  const lineCount = reasoning.split("\n").filter(Boolean).length;

  return (
    <CollapsiblePanel
      icon={<BrainCircuit className="size-4" />}
      summary="思考过程"
      detail={
        isStreaming ? (
          <span className="flex items-center gap-1 text-xs text-blue-500">
            <LoaderCircle className="size-3.5 animate-spin" />
            思考中…
          </span>
        ) : (
          <span className="text-xs text-gray-400">已完成 · {lineCount} 段</span>
        )
      }
      className="border-dashed bg-gray-50/40"
    >
      <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-600">
        {reasoning}
      </div>
    </CollapsiblePanel>
  );
}
