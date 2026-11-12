import { validate } from "uuid";
import { getApiKey } from "@/lib/api-key";
import { Message, Thread } from "@langchain/langgraph-sdk";
import {
  createContext,
  useContext,
  ReactNode,
  useCallback,
  useState,
  Dispatch,
  SetStateAction,
} from "react";
import { createClient } from "./client";
import { useAuthStore } from "@/stores/auth";

interface ThreadContextType {
  getThreads: () => Promise<Thread[]>;
  threads: Thread[];
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  threadsLoading: boolean;
  setThreadsLoading: Dispatch<SetStateAction<boolean>>;
  deleteThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  /** 以给定消息作为初始历史新建一个会话，返回新会话 id */
  createBranch: (messages: Message[]) => Promise<string>;
}

const ThreadContext = createContext<ThreadContextType | undefined>(undefined);

function getThreadSearchMetadata(
  assistantId: string,
): { graph_id: string } | { assistant_id: string } {
  if (validate(assistantId)) {
    return { assistant_id: assistantId };
  } else {
    return { graph_id: assistantId };
  }
}

export function ThreadProvider({ children }: { children: ReactNode }) {
  // 默认走 Vite 同源代理，无需在 URL 中配置；SDK 需要绝对地址
  const apiUrl =
    import.meta.env.VITE_API_URL || `${window.location.origin}/lg`;
  const assistantId = import.meta.env.VITE_ASSISTANT_ID || "agent";
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);

  const getThreads = useCallback(async (): Promise<Thread[]> => {
    if (!apiUrl || !assistantId) return [];
    const client = createClient(apiUrl, getApiKey() ?? undefined);
    // 会话按用户隔离：未登录时退回默认桶（仅本地调试会出现）
    const userId = useAuthStore.getState().user?.id;

    const threads = await client.threads.search({
      metadata: {
        ...getThreadSearchMetadata(assistantId),
        ...(userId ? { user_id: userId } : {}),
      },
      limit: 100,
    });

    return threads;
  }, [apiUrl, assistantId]);

  const deleteThread = useCallback(
    async (threadId: string): Promise<void> => {
      if (!apiUrl) return;
      const client = createClient(apiUrl, getApiKey() ?? undefined);
      await client.threads.delete(threadId);
      setThreads((prev) => prev.filter((t) => t.thread_id !== threadId));
    },
    [apiUrl],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string): Promise<void> => {
      if (!apiUrl) return;
      const client = createClient(apiUrl, getApiKey() ?? undefined);
      await client.threads.update(threadId, { metadata: { title } });
      setThreads((prev) =>
        prev.map((t) =>
          t.thread_id === threadId
            ? { ...t, metadata: { ...t.metadata, title } }
            : t,
        ),
      );
    },
    [apiUrl],
  );

  const createBranch = useCallback(
    async (messages: Message[]): Promise<string> => {
      if (!apiUrl || !assistantId) throw new Error("缺少部署地址或助手 ID");
      const client = createClient(apiUrl, getApiKey() ?? undefined);
      // assistantId 是图名时通过 graphId 绑定；是真实 assistant UUID 时放在 metadata 里，
      // 否则服务端会认为该 thread 没有 graph ID，写入状态时直接 400
      const isAssistantUuid = validate(assistantId);
      const userId = useAuthStore.getState().user?.id;
      const thread = await client.threads.create({
        graphId: isAssistantUuid ? undefined : assistantId,
        metadata: {
          ...(isAssistantUuid
            ? { assistant_id: assistantId }
            : getThreadSearchMetadata(assistantId)),
          ...(userId ? { user_id: userId } : {}),
        },
      });
      try {
        // 把截断到当前消息的历史写入新会话，不清空原会话
        await client.threads.updateState(thread.thread_id, {
          values: { messages },
        });
      } catch (error) {
        // 写入失败就删掉这个空会话，避免历史列表里留下脏数据
        await client.threads.delete(thread.thread_id).catch(() => undefined);
        throw error;
      }
      const next = await getThreads();
      setThreads(next);
      return thread.thread_id;
    },
    [apiUrl, assistantId, getThreads],
  );

  const value = {
    getThreads,
    threads,
    setThreads,
    threadsLoading,
    setThreadsLoading,
    deleteThread,
    renameThread,
    createBranch,
  };

  return (
    <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>
  );
}

export function useThreads() {
  const context = useContext(ThreadContext);
  if (context === undefined) {
    throw new Error("useThreads must be used within a ThreadProvider");
  }
  return context;
}
