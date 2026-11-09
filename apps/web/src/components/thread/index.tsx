import { v4 as uuidv4 } from "uuid";
import { ReactNode, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useStreamContext } from "@/providers/Stream";
import { useThreads } from "@/providers/Thread";
import { useState, FormEvent } from "react";
import { Button } from "../ui/button";
import { Message } from "@langchain/langgraph-sdk";
import { AssistantMessage, AssistantMessageLoading } from "./messages/ai";
import { HumanMessage } from "./messages/human";
import {
  DO_NOT_RENDER_ID_PREFIX,
  ensureToolCallsHaveResponses,
} from "@/lib/ensure-tool-responses";
import { LangGraphLogoSVG } from "../icons/langgraph";
import { TooltipIconButton } from "./tooltip-icon-button";
import {
  ArrowDown,
  ChevronDown,
  LoaderCircle,
  PanelRightOpen,
  PanelRightClose,
  SquarePen,
} from "lucide-react";
import { useQueryState, parseAsBoolean } from "nuqs";
import { useToolCallsStore } from "@/stores/tool-calls";
import { useModelsStore } from "@/stores/models";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import ThreadHistory from "./history";
import { getContentString } from "./utils";
import { toast } from "sonner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

function StickyToBottomContent(props: {
  content: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const context = useStickToBottomContext();
  return (
    <div
      ref={context.scrollRef}
      style={{ width: "100%", height: "100%" }}
      className={props.className}
    >
      <div ref={context.contentRef} className={props.contentClassName}>
        {props.content}
      </div>

      {props.footer}
    </div>
  );
}

function ScrollToBottom(props: { className?: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;
  return (
    <Button
      variant="outline"
      className={props.className}
      onClick={() => scrollToBottom()}
    >
      <ArrowDown className="w-4 h-4" />
      <span>Scroll to bottom</span>
    </Button>
  );
}

export function Thread() {
  const [threadId, setThreadId] = useQueryState("threadId");
  const [chatHistoryOpen, setChatHistoryOpen] = useQueryState(
    "chatHistoryOpen",
    parseAsBoolean.withDefault(false),
  );
  const hideToolCalls = useToolCallsStore((s) => s.hideToolCalls);
  const setHideToolCalls = useToolCallsStore((s) => s.setHideToolCalls);
  const models = useModelsStore((s) => s.models);
  const selectedModel = useModelsStore((s) => s.selectedModel);
  const setSelectedModel = useModelsStore((s) => s.setSelectedModel);
  const fetchModels = useModelsStore((s) => s.fetchModels);
  const modelsLoading = useModelsStore((s) => s.isLoading);
  const [input, setInput] = useState("");
  const [firstTokenReceived, setFirstTokenReceived] = useState(false);
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");

  const stream = useStreamContext();
  const messages = stream.messages;
  const isLoading = stream.isLoading;

  const lastError = useRef<string | undefined>(undefined);

  // 全局共用模型列表，挂载时拉取一次
  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    if (!stream.error) {
      lastError.current = undefined;
      return;
    }
    try {
      const message = (stream.error as any).message;
      if (!message || lastError.current === message) {
        // Message has already been logged. do not modify ref, return early.
        return;
      }

      // Message is defined, and it has not been logged yet. Save it, and send the error
      lastError.current = message;
      toast.error("An error occurred. Please try again.", {
        description: (
          <p>
            <strong>Error:</strong> <code>{message}</code>
          </p>
        ),
        richColors: true,
        closeButton: true,
      });
    } catch {
      // no-op
    }
  }, [stream.error]);

  // TODO: this should be part of the useStream hook
  const prevMessageLength = useRef(0);
  useEffect(() => {
    if (
      messages.length !== prevMessageLength.current &&
      messages?.length &&
      messages[messages.length - 1].type === "ai"
    ) {
      setFirstTokenReceived(true);
    }

    prevMessageLength.current = messages.length;
  }, [messages]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading || !selectedModel) return;
    setFirstTokenReceived(false);

    const newHumanMessage: Message = {
      id: uuidv4(),
      type: "human",
      content: input,
    };

    const toolMessages = ensureToolCallsHaveResponses(stream.messages);
    stream.submit(
      { messages: [...toolMessages, newHumanMessage] },
      {
        streamMode: ["values"],
        // 模型只由前端模型列表决定，后端不再读取环境变量兜底
        config: { configurable: { model: selectedModel } },
        optimisticValues: (prev) => ({
          ...prev,
          messages: [
            ...(prev.messages ?? []),
            ...toolMessages,
            newHumanMessage,
          ],
        }),
      },
    );

    setInput("");
  };

  const chatStarted = !!threadId || !!messages.length;
  const hasNoAIOrToolMessages = !messages.find(
    (m) => m.type === "ai" || m.type === "tool",
  );

  const { threads } = useThreads();
  const currentThread = threads.find((t) => t.thread_id === threadId);
  const threadTitle =
    typeof currentThread?.metadata?.title === "string"
      ? currentThread.metadata.title.trim()
      : "";
  const firstHumanMessage = messages.find((m) => m.type === "human");
  const messageTitle = firstHumanMessage
    ? getContentString(firstHumanMessage.content)
    : "";
  const currentTitle = threadTitle || messageTitle || "对话";

  return (
    <div className="flex w-full h-screen overflow-hidden">
      <div className="relative lg:flex hidden">
        <motion.div
          className="absolute h-full border-r bg-white overflow-hidden z-20"
          style={{ width: 300 }}
          animate={
            isLargeScreen
              ? { x: chatHistoryOpen ? 0 : -300 }
              : { x: chatHistoryOpen ? 0 : -300 }
          }
          initial={{ x: -300 }}
          transition={
            isLargeScreen
              ? { type: "spring", stiffness: 300, damping: 30 }
              : { duration: 0 }
          }
        >
          <div className="relative h-full" style={{ width: 300 }}>
            <ThreadHistory />
          </div>
        </motion.div>
      </div>
      <motion.div
        className={cn(
          "flex-1 flex flex-col min-w-0 overflow-hidden relative",
          !chatStarted && "grid-rows-[1fr]",
        )}
        layout={isLargeScreen}
        animate={{
          marginLeft: chatHistoryOpen ? (isLargeScreen ? 300 : 0) : 0,
          width: chatHistoryOpen
            ? isLargeScreen
              ? "calc(100% - 300px)"
              : "100%"
            : "100%",
        }}
        transition={
          isLargeScreen
            ? { type: "spring", stiffness: 300, damping: 30 }
            : { duration: 0 }
        }
      >
        {!chatStarted && (
          <div className="absolute top-0 left-0 w-full flex items-center justify-between gap-3 p-2 pl-4 z-10">
            <div>
              {(!chatHistoryOpen || !isLargeScreen) && (
                <Button
                  className="hover:bg-gray-100"
                  variant="ghost"
                  onClick={() => setChatHistoryOpen((p) => !p)}
                >
                  {chatHistoryOpen ? (
                    <PanelRightOpen className="size-5" />
                  ) : (
                    <PanelRightClose className="size-5" />
                  )}
                </Button>
              )}
            </div>
            {/* <div className="absolute top-2 right-4 flex items-center">
              <OpenGitHubRepo />
            </div> */}
          </div>
        )}
        {chatStarted && (
          <div className="flex items-center justify-between gap-3 p-2 z-10 relative">
            <div className="flex items-center justify-start gap-2 relative">
              <div className="absolute left-0 z-10">
                {(!chatHistoryOpen || !isLargeScreen) && (
                  <Button
                    className="hover:bg-gray-100"
                    variant="ghost"
                    onClick={() => setChatHistoryOpen((p) => !p)}
                  >
                    {chatHistoryOpen ? (
                      <PanelRightOpen className="size-5" />
                    ) : (
                      <PanelRightClose className="size-5" />
                    )}
                  </Button>
                )}
              </div>
              <motion.div
                className="flex gap-2 items-center cursor-pointer min-w-0"
                onClick={() => setThreadId(null)}
                animate={{
                  marginLeft: !chatHistoryOpen ? 48 : 0,
                }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                }}
              >
                <TooltipIconButton
                  size="lg"
                  className="p-4"
                  tooltip="新会话"
                  variant="ghost"
                >
                  <SquarePen className="size-5" />
                </TooltipIconButton>
              </motion.div>
            </div>
            <div className="flex-1 flex justify-center items-center">
              <span
                className="text-xl font-semibold tracking-tight truncate max-w-[40vw] md:max-w-md"
                title={currentTitle}
              >
                {currentTitle}
              </span>
            </div>

            <div className="flex items-center gap-4">
              {/* <div className="flex items-center">
                <OpenGitHubRepo />
              </div> */}
              {/* <TooltipIconButton
                size="lg"
                className="p-4"
                tooltip="新会话"
                variant="ghost"
                onClick={() => setThreadId(null)}
              >
                <SquarePen className="size-5" />
              </TooltipIconButton> */}
            </div>

            <div className="absolute inset-x-0 top-full h-5 bg-gradient-to-b from-background to-background/0" />
          </div>
        )}

        <StickToBottom className="relative flex-1 overflow-hidden">
          <StickyToBottomContent
            className={cn(
              "absolute px-4 inset-0 overflow-y-scroll [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-track]:bg-transparent",
              !chatStarted && "flex flex-col items-stretch mt-[25vh]",
              chatStarted && "grid grid-rows-[1fr_auto]",
            )}
            contentClassName="pt-8 pb-16  max-w-3xl mx-auto flex flex-col gap-4 w-full"
            content={
              <>
                {messages
                  .filter((m) => !m.id?.startsWith(DO_NOT_RENDER_ID_PREFIX))
                  // 工具结果内联在对应 AI 消息的工具调用块中，不单独渲染
                  .filter((m) => m.type !== "tool")
                  .map((message, index) =>
                    message.type === "human" ? (
                      <HumanMessage
                        key={message.id || `${message.type}-${index}`}
                        message={message}
                        isLoading={isLoading}
                      />
                    ) : (
                      <AssistantMessage
                        key={message.id || `${message.type}-${index}`}
                        message={message}
                        isLoading={isLoading}
                      />
                    ),
                  )}
                {/* Special rendering case where there are no AI/tool messages, but there is an interrupt.
                    We need to render it outside of the messages list, since there are no messages to render */}
                {hasNoAIOrToolMessages && !!stream.interrupt && (
                  <AssistantMessage
                    key="interrupt-msg"
                    message={undefined}
                    isLoading={isLoading}
                  />
                )}
                {isLoading && !firstTokenReceived && (
                  <AssistantMessageLoading />
                )}
              </>
            }
            footer={
              <div className="sticky flex flex-col items-center gap-8 bottom-0 bg-white">
                {!chatStarted && (
                  <div className="flex gap-3 items-center">
                    <LangGraphLogoSVG className="flex-shrink-0 h-8" />
                    <h1 className="text-2xl font-semibold tracking-tight">
                      Agent Chat
                    </h1>
                  </div>
                )}

                <ScrollToBottom className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 animate-in fade-in-0 zoom-in-95" />

                <div className="bg-muted rounded-2xl border shadow-xs mx-auto mb-8 w-full max-w-3xl relative z-10">
                  <form
                    onSubmit={handleSubmit}
                    className="grid grid-rows-[1fr_auto] gap-2 max-w-3xl mx-auto"
                  >
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.metaKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          const el = e.target as HTMLElement | undefined;
                          const form = el?.closest("form");
                          form?.requestSubmit();
                        }
                      }}
                      placeholder="Type your message..."
                      className="p-3.5 pb-0 border-none bg-transparent field-sizing-content shadow-none ring-0 outline-none focus:outline-none focus:ring-0 resize-none"
                    />

                    <div className="flex items-center justify-between p-2 pt-4">
                      <div>
                        <div className="flex items-center space-x-2">
                          <Switch
                            id="render-tool-calls"
                            checked={hideToolCalls}
                            onCheckedChange={setHideToolCalls}
                          />
                          <Label
                            htmlFor="render-tool-calls"
                            className="text-sm text-gray-600"
                          >
                            Hide Tool Calls
                          </Label>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <select
                            aria-label="选择模型"
                            value={selectedModel}
                            onChange={(e) =>
                              setSelectedModel(e.target.value)
                            }
                            disabled={modelsLoading || isLoading}
                            title={modelsLoading ? "加载模型中…" : "选择模型"}
                            className={cn(
                              "h-9 max-w-[12rem] cursor-pointer appearance-none truncate rounded-md border border-gray-200 bg-white py-1.5 pr-7 pl-3 text-sm text-gray-700",
                              "focus:outline-none focus:ring-2 focus:ring-gray-200 disabled:cursor-not-allowed disabled:text-gray-400",
                            )}
                          >
                            {modelsLoading && <option>加载模型中…</option>}
                            {!modelsLoading && models.length === 0 && (
                              <option>暂无可用模型</option>
                            )}
                            {models.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                          {modelsLoading ? (
                            <LoaderCircle className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-gray-400" />
                          ) : (
                            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-gray-400" />
                          )}
                        </div>
                        {stream.isLoading ? (
                          <Button key="stop" onClick={() => stream.stop()}>
                            <LoaderCircle className="w-4 h-4 animate-spin" />
                            Cancel
                          </Button>
                        ) : (
                          <Button
                            type="submit"
                            className="transition-all shadow-md"
                            disabled={isLoading || !input.trim() || !selectedModel}
                          >
                            Send
                          </Button>
                        )}
                      </div>
                    </div>
                  </form>
                </div>
              </div>
            }
          />
        </StickToBottom>
      </motion.div>
    </div>
  );
}
