import {
  XIcon,
  SendHorizontal,
  Pencil,
  Copy,
  CopyCheck,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  GitBranch,
} from "lucide-react";
import { TooltipIconButton } from "../tooltip-icon-button";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AIMessage, Message } from "@langchain/langgraph-sdk";

/** 模型接口返回的 token 用量。 */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  /** 输入中命中提示词缓存的 token 数 */
  cachedInput: number;
}

/** 读取单条 AI 消息的 token 用量，优先使用模型接口返回的原始 usage。 */
export function getMessageUsage(message: Message): TokenUsage | undefined {
  if (message.type !== "ai") return undefined;

  // response_metadata.usage 是模型接口原样返回的用量
  const raw = message.response_metadata?.usage as
    | Record<string, unknown>
    | undefined;
  if (raw) {
    const toNumber = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const input = toNumber(raw.prompt_tokens) ?? toNumber(raw.input_tokens) ?? 0;
    const output =
      toNumber(raw.completion_tokens) ?? toNumber(raw.output_tokens) ?? 0;
    const total = toNumber(raw.total_tokens) ?? input + output;
    // 缓存命中：DeepSeek 用 prompt_cache_hit_tokens，OpenAI 用 prompt_tokens_details.cached_tokens
    const details = raw.prompt_tokens_details as
      | Record<string, unknown>
      | undefined;
    const cachedInput =
      toNumber(raw.prompt_cache_hit_tokens) ??
      (details ? toNumber(details.cached_tokens) : undefined) ??
      0;
    if (total) return { input, output, total, cachedInput };
  }

  const usage = (message as AIMessage).usage_metadata;
  if (!usage) return undefined;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? input + output;
  const cachedInput = usage.input_token_details?.cache_read ?? 0;
  if (!total) return undefined;
  return { input, output, total, cachedInput };
}

/** 汇总一组消息的 token 用量（一轮对话可能包含多次模型调用）。 */
export function sumUsage(messages: Message[]): TokenUsage | undefined {
  let usage: TokenUsage | undefined;
  for (const message of messages) {
    const current = getMessageUsage(message);
    if (!current) continue;
    usage ??= { input: 0, output: 0, total: 0, cachedInput: 0 };
    usage.input += current.input;
    usage.output += current.output;
    usage.total += current.total;
    usage.cachedInput += current.cachedInput;
  }
  return usage;
}

/** 消息创建/接收时间（后端写入 additional_kwargs.created_at）。 */
export function getMessageCreatedAt(message: Message): string | undefined {
  const value = message.additional_kwargs?.created_at;
  return typeof value === "string" ? value : undefined;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatTokens(value: number): string {
  return value.toLocaleString("zh-CN");
}

/** 消息底部的用量与时间信息。 */
export function MessageStats({
  usage,
  createdAt,
}: {
  usage?: TokenUsage;
  createdAt?: string;
}) {
  const time = createdAt ? formatTime(createdAt) : "";
  if (!usage && !time) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {usage && (
        <span
          title={`输入 ${formatTokens(usage.input)} / 输出 ${formatTokens(usage.output)} / 缓存命中 ${formatTokens(usage.cachedInput)} tokens`}
        >
          共 {formatTokens(usage.total)} tokens（入 {formatTokens(usage.input)} / 出{" "}
          {formatTokens(usage.output)} / 缓存命中{" "}
          {formatTokens(usage.cachedInput)}）
        </span>
      )}
      {usage && time && <span className="text-muted-foreground/40">·</span>}
      {time && <time dateTime={createdAt}>{time}</time>}
    </div>
  );
}

export function CopyButton({
  content,
  disabled,
}: {
  content: string;
  disabled: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <TooltipIconButton
      onClick={(e) => handleCopy(e)}
      variant="ghost"
      tooltip="复制内容"
      disabled={disabled}
    >
      <AnimatePresence mode="wait" initial={false}>
        {copied ? (
          <motion.div
            key="check"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
          >
            <CopyCheck className="text-green-500" />
          </motion.div>
        ) : (
          <motion.div
            key="copy"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
          >
            <Copy />
          </motion.div>
        )}
      </AnimatePresence>
    </TooltipIconButton>
  );
}

export function BranchSwitcher({
  branch,
  branchOptions,
  onSelect,
  isLoading,
}: {
  branch: string | undefined;
  branchOptions: string[] | undefined;
  onSelect: (branch: string) => void;
  isLoading: boolean;
}) {
  if (!branchOptions || !branch) return null;
  const index = branchOptions.indexOf(branch);

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        className="size-6 p-1"
        onClick={() => {
          const prevBranch = branchOptions[index - 1];
          if (!prevBranch) return;
          onSelect(prevBranch);
        }}
        disabled={isLoading}
      >
        <ChevronLeft />
      </Button>
      <span className="text-sm">
        {index + 1} / {branchOptions.length}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 p-1"
        onClick={() => {
          const nextBranch = branchOptions[index + 1];
          if (!nextBranch) return;
          onSelect(nextBranch);
        }}
        disabled={isLoading}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

export function CommandBar({
  content,
  isHumanMessage,
  isAiMessage,
  isEditing,
  setIsEditing,
  handleSubmitEdit,
  onRefresh,
  onBranch,
  isLoading,
}: {
  content: string;
  isHumanMessage?: boolean;
  isAiMessage?: boolean;
  isEditing?: boolean;
  setIsEditing?: React.Dispatch<React.SetStateAction<boolean>>;
  handleSubmitEdit?: () => void;
  /** 基于当前消息重新生成 */
  onRefresh?: () => void;
  /** 基于当前消息新建会话分支 */
  onBranch?: () => void;
  isLoading: boolean;
}) {
  if (isHumanMessage && isAiMessage) {
    throw new Error(
      "Can only set one of isHumanMessage or isAiMessage to true, not both.",
    );
  }

  if (!isHumanMessage && !isAiMessage) {
    throw new Error(
      "One of isHumanMessage or isAiMessage must be set to true.",
    );
  }

  if (
    isHumanMessage &&
    (isEditing === undefined ||
      setIsEditing === undefined ||
      handleSubmitEdit === undefined)
  ) {
    throw new Error(
      "If isHumanMessage is true, all of isEditing, setIsEditing, and handleSubmitEdit must be set.",
    );
  }

  const showEdit =
    isHumanMessage &&
    isEditing !== undefined &&
    !!setIsEditing &&
    !!handleSubmitEdit;

  if (isHumanMessage && isEditing && !!setIsEditing && !!handleSubmitEdit) {
    return (
      <div className="flex items-center gap-2">
        <TooltipIconButton
          disabled={isLoading}
          tooltip="Cancel edit"
          variant="ghost"
          onClick={() => {
            setIsEditing(false);
          }}
        >
          <XIcon />
        </TooltipIconButton>
        <TooltipIconButton
          disabled={isLoading}
          tooltip="Submit"
          variant="secondary"
          onClick={handleSubmitEdit}
        >
          <SendHorizontal />
        </TooltipIconButton>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <CopyButton content={content} disabled={isLoading} />
      {onRefresh && (
        <TooltipIconButton
          disabled={isLoading}
          tooltip="重新生成"
          variant="ghost"
          onClick={() => onRefresh()}
        >
          <RotateCcw />
        </TooltipIconButton>
      )}
      {onBranch && (
        <TooltipIconButton
          disabled={isLoading}
          tooltip="基于此消息新建会话"
          variant="ghost"
          onClick={() => onBranch()}
        >
          <GitBranch />
        </TooltipIconButton>
      )}
      {showEdit && (
        <TooltipIconButton
          disabled={isLoading}
          tooltip="Edit"
          variant="ghost"
          onClick={() => {
            setIsEditing?.(true);
          }}
        >
          <Pencil />
        </TooltipIconButton>
      )}
    </div>
  );
}
