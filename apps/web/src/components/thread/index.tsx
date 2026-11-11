import { ReactNode, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useStreamContext } from "@/providers/Stream";
import { useThreads } from "@/providers/Thread";
import { useState, type SubmitEventHandler } from "react";
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
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  PanelRightOpen,
  PanelRightClose,
  SquarePen,
  X,
} from "lucide-react";
import { useQueryState, parseAsBoolean } from "nuqs";
import { useToolCallsStore } from "@/stores/tool-calls";
import { useModelsStore } from "@/stores/models";
import type { ModelCapabilities } from "@/lib/model-capabilities";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import ThreadHistory from "./history";
import { getContentString } from "./utils";
import { getReasoningString } from "./messages/reasoning";
import { toast } from "sonner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import {
  MAX_ATTACHMENTS,
  discardAttachment,
  kindOf,
  uploadAttachment,
  validateFile,
  waitForParse,
  type Attachment,
  type AttachmentKind,
} from "@/lib/attachments";

/** 输入框里正在上传/解析的附件 */
interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  status: "uploading" | "parsing" | "ready" | "failed";
  attachment?: Attachment;
  error?: string;
}

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

/** 能力来源的说明文案，展示在模型选择器的悬浮提示里 */
const CAPABILITY_SOURCE_LABEL: Record<ModelCapabilities["source"], string> = {
  config: "本地配置",
  gateway: "网关声明",
  pattern: "模型名匹配",
  default: "默认设置",
};

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

/** 附件大小展示 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 输入区附件状态文案 */
const PENDING_STATUS_LABEL: Record<PendingAttachment["status"], string> = {
  uploading: "上传中",
  parsing: "解析中",
  ready: "已就绪",
  failed: "失败",
};

/** 输入区附件条目：图标 + 名称 + 大小 + 状态/错误 + 移除 */
function AttachmentChip({
  item,
  onRemove,
}: {
  item: PendingAttachment;
  onRemove: () => void;
}) {
  const isBusy = item.status === "uploading" || item.status === "parsing";
  const Icon = item.kind === "image" ? ImageIcon : FileText;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 text-xs",
        item.status === "failed"
          ? "border-red-200 text-red-600"
          : "border-gray-200 text-gray-700",
      )}
      title={item.error ?? item.name}
    >
      {isBusy ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-gray-400" />
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      <span className="max-w-[10rem] truncate">{item.name}</span>
      <span className="shrink-0 text-gray-400">
        {item.status === "failed"
          ? item.error ?? "失败"
          : isBusy
            ? PENDING_STATUS_LABEL[item.status]
            : formatFileSize(item.size)}
      </span>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        onClick={onRemove}
        aria-label={`移除 ${item.name}`}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** 会话标题：优先取文字，纯附件消息用附件名兜底 */
function getTitleText(message: Message): string {
  const text = getContentString(message.content).trim();
  if (text) return text;
  const raw = (message.additional_kwargs as Record<string, unknown> | undefined)
    ?.attachments;
  if (Array.isArray(raw) && raw.length > 0) {
    const names = raw
      .map((item) => (item as { name?: string }).name)
      .filter((name): name is string => !!name);
    if (names.length > 0) return names.join(", ");
  }
  return "";
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
  const capabilities = useModelsStore((s) => s.capabilities);
  const selectedModel = useModelsStore((s) => s.selectedModel);
  const setSelectedModel = useModelsStore((s) => s.setSelectedModel);
  const fetchModels = useModelsStore((s) => s.fetchModels);
  const modelsLoading = useModelsStore((s) => s.isLoading);
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");

  const stream = useStreamContext();
  const messages = stream.messages;
  const isLoading = stream.isLoading;

  // 是否在等待 AI 输出：乐观插入的 human 消息、工具结果之后，或刚创建还没内容的 AI 消息
  const lastMessage = messages[messages.length - 1];
  const lastAiIsBlank =
    lastMessage?.type === "ai" &&
    getContentString(lastMessage.content).length === 0 &&
    !lastMessage.tool_calls?.length &&
    getReasoningString(lastMessage).length === 0;
  const isWaitingForAI =
    isLoading &&
    (!lastMessage ||
      lastMessage.type === "human" ||
      lastMessage.type === "tool" ||
      lastAiIsBlank);

  const lastError = useRef<string | undefined>(undefined);

  // 全局共用模型列表，挂载时拉取一次
  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  // 点击附件菜单外部时收起
  useEffect(() => {
    if (!isAttachMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!attachMenuRef.current?.contains(event.target as Node)) {
        setIsAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isAttachMenuOpen]);

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

  const readyAttachments = pendingAttachments.filter(
    (item): item is PendingAttachment & { attachment: Attachment } =>
      item.status === "ready" && !!item.attachment,
  );
  const hasPendingUpload = pendingAttachments.some(
    (item) => item.status === "uploading" || item.status === "parsing",
  );

  /** 上传并解析文件；图片在模型不支持视觉时直接拦下 */
  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    // 同一批文件内累加，避免闭包里的旧值导致超出上限
    let count = pendingAttachments.length;

    for (const file of list) {
      const kind = kindOf(file.type);
      if (kind === "image" && !capabilities[selectedModel]?.vision) {
        toast.error(`当前模型不支持图片输入：${file.name}`);
        continue;
      }
      const invalid = validateFile(file);
      if (invalid) {
        toast.error(`${file.name}：${invalid}`);
        continue;
      }
      if (count + 1 > MAX_ATTACHMENTS) {
        toast.error(`单次最多上传 ${MAX_ATTACHMENTS} 个附件`);
        break;
      }
      count += 1;

      const localId = crypto.randomUUID();
      setPendingAttachments((prev) => [
        ...prev,
        { localId, name: file.name, size: file.size, kind, status: "uploading" },
      ]);

      try {
        const attachment = await uploadAttachment(file);
        const needsParse =
          attachment.parse?.status && attachment.parse.status !== "skipped";

        setPendingAttachments((prev) =>
          prev.map((item) =>
            item.localId === localId
              ? {
                  ...item,
                  status: needsParse ? "parsing" : "ready",
                  attachment,
                }
              : item,
          ),
        );

        if (needsParse) {
          const parsed = await waitForParse(attachment.id);
          const failed = parsed.parse?.status === "failed";
          setPendingAttachments((prev) =>
            prev.map((item) =>
              item.localId === localId
                ? {
                    ...item,
                    status: failed ? "failed" : "ready",
                    attachment: parsed,
                    error: parsed.parse?.error,
                  }
                : item,
            ),
          );
        }
      } catch (error) {
        setPendingAttachments((prev) =>
          prev.map((item) =>
            item.localId === localId
              ? {
                  ...item,
                  status: "failed",
                  error:
                    error instanceof Error ? error.message : "上传失败",
                }
              : item,
          ),
        );
      }
    }
  };

  const removeAttachment = (localId: string) => {
    const target = pendingAttachments.find((item) => item.localId === localId);
    if (target?.attachment?.id) {
      void discardAttachment(target.attachment.id);
    }
    setPendingAttachments((prev) =>
      prev.filter((item) => item.localId !== localId),
    );
  };

  const handleSubmit: SubmitEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    if (!selectedModel || isLoading || hasPendingUpload) return;
    if (!input.trim() && readyAttachments.length === 0) return;

    const attachments = readyAttachments.map((item) => item.attachment);
    const blocks: Record<string, unknown>[] = [];
    if (input.trim()) blocks.push({ type: "text", text: input });
    for (const attachment of attachments) {
      if (attachment.kind === "image" && attachment.url) {
        blocks.push({
          type: "image_url",
          image_url: { url: attachment.url },
        });
      }
    }

    const newHumanMessage: Message = {
      id: crypto.randomUUID(),
      type: "human",
      // 纯附件消息没有文字，此时 content 只有图片块
      content:
        blocks.length === 1 && blocks[0].type === "text"
          ? input
          : blocks,
      // 记录发送时间与附件元数据，随 checkpoint 一起持久化
      additional_kwargs: {
        created_at: new Date().toISOString(),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    } as Message;

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
    setPendingAttachments([]);
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
    ? getTitleText(firstHumanMessage)
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
                {isWaitingForAI && <AssistantMessageLoading />}
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
                    className={cn(
                      "grid grid-rows-[1fr_auto] gap-2 max-w-3xl mx-auto rounded-2xl transition-colors",
                      isDraggingFile && "ring-2 ring-emerald-400 ring-offset-2",
                    )}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes("Files")) return;
                      e.preventDefault();
                      setIsDraggingFile(true);
                    }}
                    onDragLeave={(e) => {
                      // 只有真正离开表单时才取消高亮
                      if (e.currentTarget.contains(e.relatedTarget as Node)) {
                        return;
                      }
                      setIsDraggingFile(false);
                    }}
                    onDrop={(e) => {
                      if (!e.dataTransfer.files.length) return;
                      e.preventDefault();
                      setIsDraggingFile(false);
                      void addFiles(e.dataTransfer.files);
                    }}
                  >
                    {pendingAttachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 px-3.5 pt-3">
                        {pendingAttachments.map((item) => (
                          <AttachmentChip
                            key={item.localId}
                            item={item}
                            onRemove={() => removeAttachment(item.localId)}
                          />
                        ))}
                      </div>
                    )}

                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onPaste={(e) => {
                        const files = e.clipboardData?.files;
                        if (files && files.length > 0) {
                          e.preventDefault();
                          void addFiles(files);
                        }
                      }}
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
                      <div className="flex items-center gap-1">
                        <input
                          ref={imageInputRef}
                          type="file"
                          multiple
                          hidden
                          accept="image/*"
                          onChange={(e) => {
                            if (e.target.files) void addFiles(e.target.files);
                            e.target.value = "";
                          }}
                        />
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          hidden
                          accept="application/pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.csv,audio/*,video/*"
                          onChange={(e) => {
                            if (e.target.files) void addFiles(e.target.files);
                            e.target.value = "";
                          }}
                        />
                        <div className="relative" ref={attachMenuRef}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-gray-500 hover:text-gray-700"
                            title="添加附件"
                            disabled={
                              isLoading ||
                              pendingAttachments.length >= MAX_ATTACHMENTS
                            }
                            onClick={() => setIsAttachMenuOpen((open) => !open)}
                          >
                            <Plus className="size-4" />
                          </Button>
                          {isAttachMenuOpen && (
                            <div className="absolute bottom-full left-0 z-20 mb-1 w-36 rounded-lg border bg-white p-1 shadow-lg">
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                                onClick={() => {
                                  setIsAttachMenuOpen(false);
                                  imageInputRef.current?.click();
                                }}
                              >
                                <ImageIcon className="size-4" />
                                上传图片
                              </button>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                                onClick={() => {
                                  setIsAttachMenuOpen(false);
                                  fileInputRef.current?.click();
                                }}
                              >
                                <FileText className="size-4" />
                                上传文件
                              </button>
                            </div>
                          )}
                        </div>
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
                                {capabilities[model]?.vision ? "（支持图片）" : ""}
                              </option>
                            ))}
                          </select>
                          {modelsLoading ? (
                            <LoaderCircle className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-gray-400" />
                          ) : (
                            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-gray-400" />
                          )}
                        </div>
                        {selectedModel && capabilities[selectedModel] && (
                          <span
                            className={cn(
                              "rounded-md border px-1.5 py-0.5 text-[11px] whitespace-nowrap",
                              capabilities[selectedModel].vision
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-gray-200 bg-gray-50 text-gray-500",
                            )}
                            title={`能力来源：${
                              CAPABILITY_SOURCE_LABEL[
                                capabilities[selectedModel].source
                              ]
                            }`}
                          >
                            {capabilities[selectedModel].vision
                              ? "支持图片"
                              : "仅文本"}
                          </span>
                        )}
                        {stream.isLoading ? (
                          <Button key="stop" onClick={() => stream.stop()}>
                            <LoaderCircle className="w-4 h-4 animate-spin" />
                            Cancel
                          </Button>
                        ) : (
                          <Button
                            type="submit"
                            className="transition-all shadow-md"
                            disabled={
                              isLoading ||
                              hasPendingUpload ||
                              (!input.trim() && readyAttachments.length === 0) ||
                              !selectedModel
                            }
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
