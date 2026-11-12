import { useEffect, useRef, useState } from "react";
import { FolderOpen, LogOut } from "lucide-react";
import { useQueryState } from "nuqs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";
import { LibrarySheet } from "@/components/library/library-sheet";

/** 右上角用户入口：显示头像、昵称，展开后可退出登录。 */
export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [, setThreadId] = useQueryState("threadId");
  const [open, setOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!user) return null;

  const initial =
    (user.name || user.email).trim().charAt(0).toUpperCase() || "U";

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "flex items-center gap-2 rounded-full border bg-white py-1 pr-3 pl-1 shadow-sm transition-colors hover:bg-gray-50",
          open && "bg-gray-50",
        )}
      >
        <Avatar className="size-7">
          <AvatarFallback className="bg-emerald-100 text-xs font-medium text-emerald-700">
            {initial}
          </AvatarFallback>
        </Avatar>
        <span className="max-w-32 truncate text-sm text-gray-700">
          {user.name}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-56 rounded-lg border bg-white p-1 shadow-lg">
          <div className="px-2 py-2">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {user.email}
            </p>
          </div>
          <div className="my-1 h-px bg-gray-100" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            onClick={() => {
              setOpen(false);
              setLibraryOpen(true);
            }}
          >
            <FolderOpen className="size-4" />
            我的资料
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            onClick={() => {
              setOpen(false);
              // 清掉 URL 里的会话 id，避免下一个登录用户直接进入上一个用户的历史
              void setThreadId(null);
              void logout();
            }}
          >
            <LogOut className="size-4" />
            退出登录
          </button>
        </div>
      )}

      <LibrarySheet open={libraryOpen} onOpenChange={setLibraryOpen} />
    </div>
  );
}
