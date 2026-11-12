import { useCallback, useEffect, useState } from "react";
import {
  FileAudio,
  FileText,
  FileVideo,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  discardAttachment,
  fetchLibrary,
  type Attachment,
  type AttachmentKind,
} from "@/lib/attachments";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<AttachmentKind, typeof FileText> = {
  image: ImageIcon,
  document: FileText,
  audio: FileAudio,
  video: FileVideo,
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseLabel(attachment: Attachment): string {
  const status = attachment.parse?.status;
  if (attachment.kind === "image") return "图片";
  if (status === "ready") return `已解析 ${attachment.parse?.chars ?? 0} 字`;
  if (status === "failed") return "解析失败";
  if (status === "running" || status === "pending") return "解析中…";
  return "未解析";
}

/** 资料库：查看已上传文件与向量索引情况，并支持删除。 */
export function LibrarySheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [stats, setStats] = useState({ documents: 0, chunks: 0 });
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchLibrary();
      setAttachments(data.attachments);
      setStats(data.stats);
    } catch (error) {
      toast.error(
        `读取资料库失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleDelete = async (attachment: Attachment) => {
    setDeletingId(attachment.id);
    try {
      await discardAttachment(attachment.id);
      setAttachments((prev) => prev.filter((item) => item.id !== attachment.id));
      await load();
      toast.success(`已删除 ${attachment.name}`);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center justify-between">
            我的资料
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </SheetTitle>
          <SheetDescription>
            已索引 {stats.documents} 个文件 · {stats.chunks} 个片段。
            对话中提到「我上传的资料」时会自动检索这里的内容。
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {loading && attachments.length === 0 && (
            <div className="flex items-center justify-center py-10 text-sm text-gray-400">
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              加载中…
            </div>
          )}

          {!loading && attachments.length === 0 && (
            <div className="py-10 text-center text-sm text-gray-400">
              还没有上传任何资料
            </div>
          )}

          {attachments.map((attachment) => {
            const Icon = KIND_ICON[attachment.kind] ?? FileText;
            return (
              <div
                key={attachment.id}
                className="flex items-center gap-3 rounded-lg border bg-white p-3"
              >
                <Icon className="size-4 shrink-0 text-gray-400" />
                <div className="min-w-0 flex-1">
                  <a
                    href={`/uploads/${attachment.id}/content`}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-sm text-gray-800 hover:text-emerald-700"
                  >
                    {attachment.name}
                  </a>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {formatSize(attachment.size)} · {parseLabel(attachment)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-gray-400 hover:text-red-500"
                  disabled={deletingId === attachment.id}
                  onClick={() => void handleDelete(attachment)}
                >
                  {deletingId === attachment.id ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
