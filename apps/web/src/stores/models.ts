import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 模型列表接口，默认走 Vite 代理（见 vite.config.ts） */
const MODELS_ENDPOINT =
  (import.meta.env.VITE_MODELS_API_URL as string | undefined) ||
  "/openai/models";

interface ModelsState {
  models: string[];
  selectedModel: string;
  isLoading: boolean;
  error: string | null;
  fetchModels: () => Promise<void>;
  setSelectedModel: (model: string) => void;
}

// 全局共用一个请求，多个组件同时调用时不会重复拉取
let inflight: Promise<void> | null = null;

export const useModelsStore = create<ModelsState>()(
  persist(
    (set, get) => ({
      models: [],
      selectedModel: "",
      isLoading: false,
      error: null,

      fetchModels: async () => {
        if (inflight) return inflight;
        if (get().models.length > 0) return;

        set({ isLoading: true, error: null });
        inflight = fetch(MODELS_ENDPOINT)
          .then((res) => {
            if (!res.ok) throw new Error(`加载模型列表失败（${res.status}）`);
            return res.json();
          })
          .then((data: { data?: { id?: string }[] }) => {
            const models = (data?.data ?? [])
              .map((item) => item.id)
              .filter((id): id is string => !!id)
              .sort();
            const selected = get().selectedModel;
            set({
              models,
              selectedModel: models.includes(selected)
                ? selected
                : (models[0] ?? ""),
              isLoading: false,
            });
          })
          .catch((error: unknown) => {
            set({
              isLoading: false,
              error:
                error instanceof Error ? error.message : "加载模型列表失败",
            });
          })
          .finally(() => {
            inflight = null;
          });

        return inflight;
      },

      setSelectedModel: (selectedModel) => set({ selectedModel }),
    }),
    {
      name: "chat-model",
      partialize: (state) => ({ selectedModel: state.selectedModel }),
    },
  ),
);
