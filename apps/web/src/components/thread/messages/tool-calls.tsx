import { AIMessage, Message, ToolMessage } from "@langchain/langgraph-sdk";
import {
  CheckCircle2,
  CircleDashed,
  CircleX,
  LoaderCircle,
  Wrench,
} from "lucide-react";
import { CollapsiblePanel } from "./collapsible";
import { cn } from "@/lib/utils";

type ToolStatus = "pending" | "running" | "success" | "error";

interface ToolResultInfo {
  content: string;
  status?: string;
  name?: string;
}

function stringifyContent(content: ToolMessage["content"]): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/** 收集工具结果，按 tool_call_id 索引，供工具调用块内联展示。 */
export function collectToolResults(
  messages: Message[],
): Map<string, ToolResultInfo> {
  const results = new Map<string, ToolResultInfo>();
  for (const message of messages) {
    if (message.type !== "tool") continue;
    const toolMessage = message as ToolMessage;
    if (!toolMessage.tool_call_id) continue;
    results.set(toolMessage.tool_call_id, {
      content: stringifyContent(toolMessage.content),
      status: toolMessage.status,
      name: toolMessage.name,
    });
  }
  return results;
}

function getToolStatus(
  toolCallId: string,
  results: Map<string, ToolResultInfo>,
  isStreaming: boolean,
): ToolStatus {
  const result = results.get(toolCallId);
  if (result) {
    return result.status === "error" ? "error" : "success";
  }
  return isStreaming ? "running" : "pending";
}

const STATUS_META: Record<
  ToolStatus,
  { label: string; className: string; icon: typeof CircleDashed }
> = {
  pending: {
    label: "未执行",
    className: "text-gray-400",
    icon: CircleDashed,
  },
  running: {
    label: "执行中",
    className: "text-blue-500",
    icon: LoaderCircle,
  },
  success: {
    label: "已完成",
    className: "text-green-600",
    icon: CheckCircle2,
  },
  error: {
    label: "执行失败",
    className: "text-red-500",
    icon: CircleX,
  },
};

function ToolStatusBadge({ status }: { status: ToolStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs",
        meta.className,
      )}
    >
      <Icon className={cn("size-3.5", status === "running" && "animate-spin")} />
      {meta.label}
    </span>
  );
}

export function getToolStatuses(
  toolCalls: AIMessage["tool_calls"],
  results: Map<string, ToolResultInfo>,
  isStreaming: boolean,
): ToolStatus[] {
  return (toolCalls ?? []).map((tc) =>
    getToolStatus(tc.id ?? "", results, isStreaming),
  );
}

/** 工具调用汇总文案，用于外层过程面板的标题行。 */
export function getToolSummary(
  toolCalls: AIMessage["tool_calls"],
  results: Map<string, ToolResultInfo>,
  isStreaming: boolean,
): string {
  const statuses = getToolStatuses(toolCalls, results, isStreaming);
  const total = statuses.length;
  if (total === 0) return "";
  const runningCount = statuses.filter((s) => s === "running").length;
  const errorCount = statuses.filter((s) => s === "error").length;

  if (runningCount > 0) return `正在调用 ${total} 个工具`;
  if (errorCount > 0) return `已调用 ${total} 个工具（${errorCount} 个失败）`;
  if (statuses.every((s) => s === "success")) return `已调用 ${total} 个工具`;
  return `调用 ${total} 个工具`;
}

export function ToolCalls({
  toolCalls,
  results = new Map(),
  isStreaming = false,
}: {
  toolCalls: AIMessage["tool_calls"];
  results?: Map<string, ToolResultInfo>;
  isStreaming?: boolean;
}) {
  if (!toolCalls || toolCalls.length === 0) return null;

  const statuses = getToolStatuses(toolCalls, results, isStreaming);

  return (
    <div className="w-full space-y-2">
      {toolCalls.map((tc, idx) => {
        const args = (tc.args ?? {}) as Record<string, any>;
        const hasArgs = Object.keys(args).length > 0;
        const result = results.get(tc.id ?? "");
        const status = statuses[idx];

        return (
          <CollapsiblePanel
            key={tc.id || idx}
            icon={<Wrench className={cn("size-4", status === "running" && "text-blue-500")} />}
            summary={tc.name || "工具调用"}
            detail={<ToolStatusBadge status={status} />}
            className="bg-white"
          >
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs font-medium text-gray-500">
                  参数
                </div>
                {hasArgs ? (
                  <pre className="max-h-64 overflow-auto rounded-md bg-gray-50 p-2 font-mono text-xs text-gray-700">
                    {JSON.stringify(args, null, 2)}
                  </pre>
                ) : (
                  <code className="text-xs text-gray-500">{"{}"}</code>
                )}
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-gray-500">
                  结果
                </div>
                {result ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-2 font-mono text-xs text-gray-700">
                    {result.content}
                  </pre>
                ) : (
                  <div className="text-xs text-gray-400">
                    {status === "running" ? "执行中…" : "暂无返回结果"}
                  </div>
                )}
              </div>
            </div>
          </CollapsiblePanel>
        );
      })}
    </div>
  );
}

/** 独立渲染的历史工具消息（当找不到对应工具调用时兜底）。 */
export function ToolResult({ message }: { message: ToolMessage }) {
  const content = stringifyContent(message.content);
  return (
    <CollapsiblePanel
      icon={<Wrench className="size-4" />}
      summary={message.name ? `工具结果 · ${message.name}` : "工具结果"}
      detail={<ToolStatusBadge status={message.status === "error" ? "error" : "success"} />}
      className="bg-white"
    >
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-2 font-mono text-xs text-gray-700">
        {content}
      </pre>
    </CollapsiblePanel>
  );
}
