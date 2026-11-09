import { parsePartialJson } from "@langchain/core/output_parsers";
import { useStreamContext } from "@/providers/Stream";
import { AIMessage, Message } from "@langchain/langgraph-sdk";
import { getContentString } from "../utils";
import { BranchSwitcher, CommandBar } from "./shared";
import { MarkdownText } from "../markdown-text";
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";
import { cn } from "@/lib/utils";
import { ToolCalls, collectToolResults, getToolSummary } from "./tool-calls";
import { ReasoningPanel, getReasoningString } from "./reasoning";
import { CollapsiblePanel } from "./collapsible";
import { LoaderCircle, Sparkles } from "lucide-react";
import { Fragment } from "react/jsx-runtime";
import { useMemo } from "react";
import { isAgentInboxInterruptSchema } from "@/lib/agent-inbox-interrupt";
import { ThreadView } from "../agent-inbox";
import { useToolCallsStore } from "@/stores/tool-calls";
import { GenericInterruptView } from "./generic-interrupt";

function CustomComponent({
  message,
  thread,
}: {
  message: Message;
  thread: ReturnType<typeof useStreamContext>;
}) {
  const { values } = useStreamContext();
  const customComponents = values.ui?.filter(
    (ui) => ui.metadata?.message_id === message.id,
  );

  if (!customComponents?.length) return null;
  return (
    <Fragment key={message.id}>
      {customComponents.map((customComponent) => (
        <LoadExternalComponent
          key={customComponent.id}
          stream={thread as any}
          message={customComponent}
          meta={{ ui: customComponent }}
        />
      ))}
    </Fragment>
  );
}

function parseAnthropicStreamedToolCalls(
  content: Message["content"],
): AIMessage["tool_calls"] {
  if (!Array.isArray(content)) return [];
  const toolCallContents = content.filter(
    (c: Record<string, any>) => c.type === "tool_use" && c.id,
  );

  return toolCallContents.map((tc) => {
    const toolCall = tc as Record<string, any>;
    let json: Record<string, any> = {};
    if (toolCall?.input) {
      try {
        json = parsePartialJson(toolCall.input) ?? {};
      } catch {
        // Pass
      }
    }
    return {
      name: toolCall.name ?? "",
      id: toolCall.id ?? "",
      args: json,
      type: "tool_call",
    };
  });
}

export function AssistantMessage({
  message,
  isLoading,
}: {
  message: Message | undefined;
  isLoading: boolean;
}) {
  const content = message?.content ?? [];
  const contentString = getContentString(content);
  const hideToolCalls = useToolCallsStore((s) => s.hideToolCalls);

  const thread = useStreamContext();
  const isLastMessage =
    thread.messages[thread.messages.length - 1].id === message?.id;
  const hasNoAIOrToolMessages = !thread.messages.find(
    (m) => m.type === "ai" || m.type === "tool",
  );
  const meta = message ? thread.getMessagesMetadata(message) : undefined;
  const threadInterrupt = thread.interrupt;

  // 工具结果统一内联到对应的工具调用块里展示，独立的 tool 消息由列表层过滤掉
  const toolResults = useMemo(
    () => collectToolResults(thread.messages),
    [thread.messages],
  );
  // 最后一条 AI 消息可能后面还跟着 tool 消息，这里按“最后一条 AI 消息”判断流式状态
  const lastAiMessageId = useMemo(() => {
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      if (thread.messages[i].type === "ai") return thread.messages[i].id;
    }
    return undefined;
  }, [thread.messages]);

  // 一轮对话（两条 human 消息之间）可能触发多次思考与工具调用，
  // 统一聚合到该轮第一条 AI 消息处，由外层过程面板包裹展示
  const turn = useMemo<{
    items: {
      id: string;
      reasoning: string;
      isStreaming: boolean;
      toolCalls?: NonNullable<AIMessage["tool_calls"]>;
    }[];
    toolCalls: NonNullable<AIMessage["tool_calls"]>;
    isOwner: boolean;
    isStreaming: boolean;
  }>(() => {
    const messages = thread.messages;
    const index = message
      ? messages.findIndex((m) => m.id === message.id)
      : -1;
    if (index === -1) {
      return { items: [], toolCalls: [], isOwner: false, isStreaming: false };
    }

    let start = index;
    while (start > 0 && messages[start - 1].type !== "human") start--;
    let end = index;
    while (end + 1 < messages.length && messages[end + 1].type !== "human") {
      end++;
    }

    const aiMessages = messages
      .slice(start, end + 1)
      .filter((m) => m.type === "ai");

    // 该轮所有工具调用汇总，统一挂在第一条含工具调用的 AI 消息上
    const toolCallsByMessage = aiMessages.map((aiMessage) =>
      aiMessage.tool_calls?.length
        ? aiMessage.tool_calls
        : parseAnthropicStreamedToolCalls(aiMessage.content),
    );
    const ownerIndex = toolCallsByMessage.findIndex(
      (calls) => !!calls && calls.length > 0,
    );
    const allToolCalls: NonNullable<AIMessage["tool_calls"]> =
      toolCallsByMessage.flatMap((calls) => calls ?? []);

    const containsLastAi = aiMessages.some((m) => m.id === lastAiMessageId);
    const items = aiMessages
      .map((aiMessage, i) => ({
        id: aiMessage.id ?? `ai-${start + i}`,
        reasoning: getReasoningString(aiMessage),
        isStreaming: isLoading && aiMessage.id === lastAiMessageId,
        toolCalls: i === ownerIndex ? allToolCalls : toolCallsByMessage[i],
      }))
      .filter(
        (item) =>
          !!item.reasoning || (item.toolCalls && item.toolCalls.length > 0),
      );

    return {
      items,
      toolCalls: allToolCalls,
      isOwner: aiMessages[0]?.id === message?.id,
      isStreaming: isLoading && containsLastAi,
    };
  }, [thread.messages, message, isLoading, lastAiMessageId]);

  const toolSummary = hideToolCalls
    ? ""
    : getToolSummary(turn.toolCalls, toolResults, turn.isStreaming);

  return (
    <div className="flex items-start mr-auto gap-2 group">
      <div className="flex flex-col gap-2">
        {turn.isOwner && turn.items.length > 0 && (
          <CollapsiblePanel
            icon={<Sparkles className="size-4" />}
            summary="过程"
            detail={
              <span className="flex items-center gap-2">
                {turn.isStreaming && (
                  <LoaderCircle className="size-3.5 animate-spin text-blue-500" />
                )}
                {toolSummary && <span>{toolSummary}</span>}
                {!toolSummary && !turn.isStreaming && <span>已完成</span>}
              </span>
            }
            className="border-dashed bg-gray-50/40"
          >
            <div className="space-y-2">
              {turn.items.map((item) => (
                <Fragment key={item.id}>
                  {item.reasoning && (
                    <ReasoningPanel
                      reasoning={item.reasoning}
                      isStreaming={item.isStreaming}
                    />
                  )}
                  {!hideToolCalls &&
                    item.toolCalls &&
                    item.toolCalls.length > 0 && (
                      <ToolCalls
                        toolCalls={item.toolCalls}
                        results={toolResults}
                        isStreaming={turn.isStreaming}
                      />
                    )}
                </Fragment>
              ))}
            </div>
          </CollapsiblePanel>
        )}

        {contentString.length > 0 && (
          <div className="py-1">
            <MarkdownText>{contentString}</MarkdownText>
          </div>
        )}

        {message && <CustomComponent message={message} thread={thread} />}
        {isAgentInboxInterruptSchema(threadInterrupt?.value) &&
          (isLastMessage || hasNoAIOrToolMessages) && (
            <ThreadView interrupt={threadInterrupt.value} />
          )}
        {threadInterrupt?.value &&
        !isAgentInboxInterruptSchema(threadInterrupt.value) &&
        isLastMessage ? (
          <GenericInterruptView interrupt={threadInterrupt.value} />
        ) : null}
        {contentString.length > 0 && (
          <div
            className={cn(
              "flex gap-2 items-center mr-auto transition-opacity",
              "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            <BranchSwitcher
              branch={meta?.branch}
              branchOptions={meta?.branchOptions}
              onSelect={(branch) => thread.setBranch(branch)}
              isLoading={isLoading}
            />
            <CommandBar
              content={contentString}
              isLoading={isLoading}
              isAiMessage={true}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function AssistantMessageLoading() {
  return (
    <div className="flex items-start mr-auto gap-2">
      <div className="flex items-center gap-1 rounded-2xl bg-muted px-4 py-2 h-8">
        <div className="w-1.5 h-1.5 rounded-full bg-foreground/50 animate-[pulse_1.5s_ease-in-out_infinite]"></div>
        <div className="w-1.5 h-1.5 rounded-full bg-foreground/50 animate-[pulse_1.5s_ease-in-out_0.5s_infinite]"></div>
        <div className="w-1.5 h-1.5 rounded-full bg-foreground/50 animate-[pulse_1.5s_ease-in-out_1s_infinite]"></div>
      </div>
    </div>
  );
}
