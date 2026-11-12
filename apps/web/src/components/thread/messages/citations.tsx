import { FileText, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Citation } from "./tool-calls";

/** 资料检索引用：展示召回的文件片段，可下载原文件对照。 */
export function CitationList({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-gray-200 bg-gray-50/60 p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
        <FileText className="size-3.5" />
        参考资料
      </div>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((citation) => (
          <a
            key={`${citation.attachmentId}:${citation.chunkIndex}`}
            href={`/uploads/${citation.attachmentId}/content`}
            target="_blank"
            rel="noreferrer"
            title={
              citation.score === undefined
                ? citation.sourceName
                : `${citation.sourceName} · 相似度 ${citation.score.toFixed(2)}`
            }
            className={cn(
              "group inline-flex max-w-full items-center gap-1.5 rounded-md border bg-white px-2 py-1",
              "text-xs text-gray-600 transition-colors hover:border-emerald-300 hover:text-emerald-700",
            )}
          >
            <span className="shrink-0 font-mono text-[11px] text-emerald-600">
              [{citation.index}]
            </span>
            <span className="truncate">{citation.sourceName}</span>
            <span className="shrink-0 text-[11px] text-gray-400">
              第 {citation.chunkIndex + 1} 段
            </span>
            <Download className="size-3 shrink-0 text-gray-300 group-hover:text-emerald-500" />
          </a>
        ))}
      </div>
    </div>
  );
}
