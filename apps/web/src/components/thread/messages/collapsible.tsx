import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 可折叠面板：默认收起，标题行始终展示当前状态（summary + detail），
 * 点击标题行展开/收起内容。
 */
export function CollapsiblePanel({
  summary,
  detail,
  icon,
  defaultOpen = false,
  className,
  children,
}: {
  summary: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50/60",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100"
      >
        {icon && <span className="shrink-0 text-gray-500">{icon}</span>}
        <span className="shrink-0 font-medium text-gray-700">{summary}</span>
        {detail && (
          <span className="min-w-0 truncate text-gray-400">{detail}</span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto size-4 shrink-0 text-gray-400 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-gray-200 px-3 py-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
