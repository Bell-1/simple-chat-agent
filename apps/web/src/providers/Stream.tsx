import React, {
  createContext,
  useContext,
  ReactNode,
  useEffect,
} from "react";
import { useStream } from "@langchain/langgraph-sdk/react";
import { type Message } from "@langchain/langgraph-sdk";
import {
  uiMessageReducer,
  type UIMessage,
  type RemoveUIMessage,
} from "@langchain/langgraph-sdk/react-ui";
import { useQueryState } from "nuqs";
import { getApiKey } from "@/lib/api-key";
import { useThreads } from "./Thread";
import { createClient } from "./client";
import { useAuthStore } from "@/stores/auth";
import { toast } from "sonner";

export type StateType = { messages: Message[]; ui?: UIMessage[] };

const useTypedStream = useStream<
  StateType,
  {
    UpdateType: {
      messages?: Message[] | Message | string;
      ui?: (UIMessage | RemoveUIMessage)[] | UIMessage | RemoveUIMessage;
    };
    CustomEventType: UIMessage | RemoveUIMessage;
  }
>;

type StreamContextType = ReturnType<typeof useTypedStream>;
const StreamContext = createContext<StreamContextType | undefined>(undefined);

async function sleep(ms = 4000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkGraphStatus(
  apiUrl: string,
  apiKey: string | null,
): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/info`, {
      ...(apiKey && {
        headers: {
          "X-Api-Key": apiKey,
        },
      }),
    });

    return res.ok;
  } catch (e) {
    console.error(e);
    return false;
  }
}

const StreamSession = ({
  children,
  apiKey,
  apiUrl,
  assistantId,
}: {
  children: ReactNode;
  apiKey: string | null;
  apiUrl: string;
  assistantId: string;
}) => {
  const [threadId, setThreadId] = useQueryState("threadId");
  const { getThreads, setThreads } = useThreads();
  const streamValue = useTypedStream({
    apiUrl,
    apiKey: apiKey ?? undefined,
    assistantId,
    threadId: threadId ?? null,
    // 记录运行中的 runId，切走会话再切回来时自动 join 未完成的流
    reconnectOnMount: true,
    // 拉取检查点历史：重新生成、编辑并重发、分支切换都依赖 meta.firstSeenState.parent_checkpoint
    fetchStateHistory: true,
    onCustomEvent: (event, options) => {
      options.mutate((prev) => {
        const ui = uiMessageReducer(prev.ui ?? [], event);
        return { ...prev, ui };
      });
    },
    onThreadId: (id) => {
      setThreadId(id);
      // 新会话自动创建时不带用户信息，这里补写 metadata，便于按用户过滤历史
      const userId = useAuthStore.getState().user?.id;
      if (userId) {
        const client = createClient(apiUrl, apiKey ?? undefined);
        void client.threads
          .get(id)
          .then((thread) =>
            client.threads.update(id, {
              metadata: { ...thread.metadata, user_id: userId },
            }),
          )
          .catch((error) => console.error(error));
      }
      // Refetch threads list when thread ID changes.
      // Wait for some seconds before fetching so we're able to get the new thread that was created.
      sleep().then(() => getThreads().then(setThreads).catch(console.error));
    },
  });

  useEffect(() => {
    checkGraphStatus(apiUrl, apiKey).then((ok) => {
      if (!ok) {
        toast.error("Failed to connect to LangGraph server", {
          description: () => (
            <p>
              Please ensure your graph is running at <code>{apiUrl}</code> and
              your API key is correctly set (if connecting to a deployed graph).
            </p>
          ),
          duration: 10000,
          richColors: true,
          closeButton: true,
        });
      }
    });
  }, [apiKey, apiUrl]);

  return (
    <StreamContext.Provider value={streamValue}>
      {children}
    </StreamContext.Provider>
  );
};

// 默认走 Vite 同源代理：/lg → http://localhost:2024，无需在环境变量或 URL 中配置。
// SDK 内部会用 new URL 解析，必须给绝对地址，因此拼上当前页面的 origin。
const DEFAULT_API_URL = `${window.location.origin}/lg`;
const DEFAULT_ASSISTANT_ID = "agent";

export const StreamProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  // 仅生产部署需要覆盖时再设置；本地开发完全依赖代理
  const envApiUrl: string | undefined = import.meta.env.VITE_API_URL;
  const envAssistantId: string | undefined = import.meta.env.VITE_ASSISTANT_ID;
  const envApiKey: string | undefined = import.meta.env.VITE_LANGSMITH_API_KEY;

  const apiUrl = envApiUrl || DEFAULT_API_URL;
  const assistantId = envAssistantId || DEFAULT_ASSISTANT_ID;

  // API key 仅用于连接已部署的 LangGraph，本地开发留空即可
  const apiKey = getApiKey() || envApiKey || "";

  return (
    <StreamSession apiKey={apiKey} apiUrl={apiUrl} assistantId={assistantId}>
      {children}
    </StreamSession>
  );
};

// Create a custom hook to use the context
export const useStreamContext = (): StreamContextType => {
  const context = useContext(StreamContext);
  if (context === undefined) {
    throw new Error("useStreamContext must be used within a StreamProvider");
  }
  return context;
};

export default StreamContext;
