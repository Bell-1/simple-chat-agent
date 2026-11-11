import { useStreamContext } from "@/providers/Stream";
import { Message } from "@langchain/langgraph-sdk";
import { useState } from "react";
import { getContentString } from "../utils";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { BranchSwitcher, CommandBar, MessageStats, getMessageCreatedAt } from "./shared";
import { useModelsStore } from "@/stores/models";
import { useThreads } from "@/providers/Thread";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
import { FileText, Music, Video } from "lucide-react";
import type { Attachment } from "@/lib/attachments";

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getMessageAttachments(message: Message): Attachment[] {
  const raw = (message.additional_kwargs as Record<string, unknown> | undefined)
    ?.attachments;
  return Array.isArray(raw) ? (raw as Attachment[]) : [];
}

/** 用户消息里的附件展示：图片网格 + 文件卡片 */
function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((item) => item.kind === "image");
  const files = attachments.filter((item) => item.kind !== "image");

  return (
    <div className="flex flex-col gap-2 items-end">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 justify-end">
          {images.map((image) => (
            <a
              key={image.id}
              href={image.url}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-xl border bg-white"
            >
              <img
                src={image.url}
                alt={image.name}
                className="max-h-48 max-w-[12rem] object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 justify-end">
          {files.map((file) => {
            const Icon =
              file.kind === "audio"
                ? Music
                : file.kind === "video"
                  ? Video
                  : FileText;
            const failed = file.parse?.status === "failed";
            return (
              <div
                key={file.id}
                className={cn(
                  "flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-xs",
                  failed
                    ? "border-red-200 text-red-600"
                    : "border-gray-200 text-gray-700",
                )}
                title={failed ? file.parse?.error : file.name}
              >
                <Icon className="size-4 shrink-0" />
                <span className="max-w-[12rem] truncate">{file.name}</span>
                <span className="shrink-0 text-gray-400">
                  {failed ? "解析失败" : formatFileSize(file.size)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EditableContent({
  value,
  setValue,
  onSubmit,
}: {
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  onSubmit: () => void;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <Textarea
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className="focus-visible:ring-0"
    />
  );
}

export function HumanMessage({
  message,
  isLoading,
}: {
  message: Message;
  isLoading: boolean;
}) {
  const thread = useStreamContext();
  const selectedModel = useModelsStore((s) => s.selectedModel);
  const meta = thread.getMessagesMetadata(message);
  const parentCheckpoint = meta?.firstSeenState?.parent_checkpoint;
  const { createBranch } = useThreads();
  const [, setThreadId] = useQueryState("threadId");

  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState("");
  const contentString = getContentString(message.content);
  const attachments = getMessageAttachments(message);
  // 纯附件消息没有文字，复制时用附件名兜底
  const copyContent =
    contentString ||
    attachments.map((item) => item.name).join(", ");

  const handleSubmitEdit = () => {
    setIsEditing(false);

    const newMessage: Message = {
      type: "human",
      content: value,
      // 记录发送时间，随 checkpoint 一起持久化，刷新后仍可展示
      additional_kwargs: {
        created_at: new Date().toISOString(),
        // 编辑文字时保留原消息的附件
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    };
    thread.submit(
      { messages: [newMessage] },
      {
        checkpoint: parentCheckpoint,
        streamMode: ["values"],
        // 模型只由前端模型列表决定，编辑消息重发时同样需要透传
        config: { configurable: { model: selectedModel } },
        optimisticValues: (prev) => {
          const values = meta?.firstSeenState?.values;
          if (!values) return prev;

          return {
            ...values,
            messages: [...(values.messages ?? []), newMessage],
          };
        },
      },
    );
  };

  /** 以这条用户消息为结尾的历史新建会话，便于换个问法继续 */
  const handleBranch = async () => {
    const index = thread.messages.findIndex((m) => m.id === message.id);
    if (index === -1) return;
    try {
      const newThreadId = await createBranch(
        thread.messages.slice(0, index + 1),
      );
      setThreadId(newThreadId);
    } catch {
      toast.error("新建分支会话失败");
    }
  };

  return (
    <div
      className={cn(
        "flex items-center ml-auto gap-2 group",
        isEditing && "w-full max-w-xl",
      )}
    >
      <div className={cn("flex flex-col gap-2", isEditing && "w-full")}>
        {isEditing ? (
          <EditableContent
            value={value}
            setValue={setValue}
            onSubmit={handleSubmitEdit}
          />
        ) : (
          <div className="flex flex-col gap-2 items-end">
            {attachments.length > 0 && (
              <MessageAttachments attachments={attachments} />
            )}
            {contentString && (
              <p className="px-4 py-2 rounded-3xl bg-muted w-fit ml-auto whitespace-pre-wrap">
                {contentString}
              </p>
            )}
          </div>
        )}

        <div
          className={cn(
            "flex gap-2 items-center ml-auto transition-opacity",
            "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            isEditing && "opacity-100",
          )}
        >
          <BranchSwitcher
            branch={meta?.branch}
            branchOptions={meta?.branchOptions}
            onSelect={(branch) => thread.setBranch(branch)}
            isLoading={isLoading}
          />
          <CommandBar
            isLoading={isLoading}
            content={copyContent}
            isEditing={isEditing}
            setIsEditing={(c) => {
              if (c) {
                setValue(contentString);
              }
              setIsEditing(c);
            }}
            handleSubmitEdit={handleSubmitEdit}
            isHumanMessage={true}
            onBranch={handleBranch}
          />
          <MessageStats createdAt={getMessageCreatedAt(message)} />
        </div>
      </div>
    </div>
  );
}
