import { Button } from "@/components/ui/button";
import { useThreads } from "@/providers/Thread";
import { Thread } from "@langchain/langgraph-sdk";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getContentString } from "../utils";
import { useQueryState, parseAsBoolean } from "nuqs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MoreHorizontal,
  PanelRightOpen,
  PanelRightClose,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useMediaQuery } from "@/hooks/useMediaQuery";

function ThreadList({
  threads,
  onThreadClick,
}: {
  threads: Thread[];
  onThreadClick?: (threadId: string) => void;
}) {
  const [threadId, setThreadId] = useQueryState("threadId");
  const { deleteThread, renameThread } = useThreads();

  const [menu, setMenu] = useState<{
    threadId: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    threadId: string;
    title: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    threadId: string;
    title: string;
  } | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuTriggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onScroll = () => setMenu(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  const openMenu = (
    e: React.MouseEvent<HTMLButtonElement>,
    target: { threadId: string; title: string },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (menu?.threadId === target.threadId) {
      setMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 144;
    const menuHeight = 84;
    const x = Math.max(
      8,
      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8),
    );
    const y =
      rect.bottom + menuHeight + 8 > window.innerHeight
        ? Math.max(8, rect.top - menuHeight - 4)
        : rect.bottom + 4;
    menuTriggerRef.current = e.currentTarget;
    setMenu({ ...target, x, y });
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const title = titleInput.trim();
    if (!title) return;
    setSubmitting(true);
    try {
      await renameThread(renameTarget.threadId, title);
      setRenameTarget(null);
      toast.success("会话已重命名");
    } catch (error) {
      toast.error("重命名失败", {
        description: (error as Error)?.message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setSubmitting(true);
    try {
      await deleteThread(deleteTarget.threadId);
      if (deleteTarget.threadId === threadId) {
        setThreadId(null);
      }
      setDeleteTarget(null);
      toast.success("会话已删除");
    } catch (error) {
      toast.error("删除失败", {
        description: (error as Error)?.message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="h-full flex flex-col w-full gap-2 items-start justify-start overflow-y-scroll [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-track]:bg-transparent">
        {threads.map((t) => {
          let itemText = t.thread_id;
          if (
            typeof t.values === "object" &&
            t.values &&
            "messages" in t.values &&
            Array.isArray(t.values.messages) &&
            t.values.messages?.length > 0
          ) {
            const firstMessage = t.values.messages[0];
            itemText = getContentString(firstMessage.content);
          }

          const customTitle =
            typeof t.metadata?.title === "string" ? t.metadata.title.trim() : "";
          const title = customTitle || itemText;

          return (
            <div key={t.thread_id} className="w-full px-1">
              <div className="flex items-center w-[280px] rounded-md group">
                <Button
                  variant="ghost"
                  className="text-left items-start justify-start font-normal flex-1 min-w-0"
                  onClick={(e) => {
                    e.preventDefault();
                    onThreadClick?.(t.thread_id);
                    if (t.thread_id === threadId) return;
                    setThreadId(t.thread_id);
                  }}
                >
                  <p className="truncate text-ellipsis">{title}</p>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="更多操作"
                  className="shrink-0 size-8 text-gray-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[open=true]:opacity-100"
                  data-open={menu?.threadId === t.thread_id}
                  onClick={(e) =>
                    openMenu(e, { threadId: t.thread_id, title })
                  }
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="pointer-events-auto fixed z-50 w-36 rounded-md border bg-white p-1 shadow-md"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-gray-100"
              onClick={() => {
                setTitleInput(menu.title);
                setRenameTarget({ threadId: menu.threadId, title: menu.title });
                setMenu(null);
              }}
            >
              <Pencil className="size-4" />
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-red-600 hover:bg-gray-100"
              onClick={() => {
                setDeleteTarget({
                  threadId: menu.threadId,
                  title: menu.title,
                });
                setMenu(null);
              }}
            >
              <Trash2 className="size-4" />
              删除
            </button>
          </div>,
          document.body,
        )}

      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open && !submitting) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>输入一个新的会话名称。</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRename();
            }}
            className="flex flex-col gap-4"
          >
            <Input
              autoFocus
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder="会话名称"
              maxLength={100}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => setRenameTarget(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={submitting || !titleInput.trim()}
              >
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !submitting) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>
              确定要删除「{deleteTarget?.title}」吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={submitting}
              onClick={() => void handleDelete()}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ThreadHistoryLoading() {
  return (
    <div className="h-full flex flex-col w-full gap-2 items-start justify-start overflow-y-scroll [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-track]:bg-transparent">
      {Array.from({ length: 30 }).map((_, i) => (
        <Skeleton key={`skeleton-${i}`} className="w-[280px] h-10" />
      ))}
    </div>
  );
}

export default function ThreadHistory() {
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");
  const [chatHistoryOpen, setChatHistoryOpen] = useQueryState(
    "chatHistoryOpen",
    parseAsBoolean.withDefault(false),
  );

  const { getThreads, threads, setThreads, threadsLoading, setThreadsLoading } =
    useThreads();

  useEffect(() => {
    if (typeof window === "undefined") return;
    setThreadsLoading(true);
    getThreads()
      .then(setThreads)
      .catch(console.error)
      .finally(() => setThreadsLoading(false));
  }, []);

  return (
    <>
      <div className="hidden lg:flex flex-col border-r-[1px] border-slate-300 items-start justify-start gap-6 h-screen w-[300px] shrink-0 shadow-inner-right">
        <div className="flex items-center justify-between w-full pt-1.5 px-4">
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
          <h1 className="text-xl font-semibold tracking-tight">
            历史会话
          </h1>
        </div>
        {threadsLoading ? (
          <ThreadHistoryLoading />
        ) : (
          <ThreadList threads={threads} />
        )}
      </div>
      <div className="lg:hidden">
        <Sheet
          open={!!chatHistoryOpen && !isLargeScreen}
          onOpenChange={(open) => {
            if (isLargeScreen) return;
            setChatHistoryOpen(open);
          }}
        >
          <SheetContent side="left" className="lg:hidden flex">
            <SheetHeader>
              <SheetTitle>历史会话</SheetTitle>
            </SheetHeader>
            <ThreadList
              threads={threads}
              onThreadClick={() => setChatHistoryOpen((o) => !o)}
            />
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
