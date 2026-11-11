import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  resolveModelCapabilities,
  type ModelCapabilities,
} from "@/lib/model-capabilities";

/** 模型列表接口，默认走 Vite 代理（见 vite.config.ts） */
const MODELS_ENDPOINT =
  (import.meta.env.VITE_MODELS_API_URL as string | undefined) ||
  "/openai/models";

interface ModelsState {
  models: string[];
  /** 模型 id -> 能力，来自本地配置与网关 modalities 的合并结果 */
  capabilities: Record<string, ModelCapabilities>;
  selectedModel: string;
  isLoading: boolean;
  error: string | null;
  fetchModels: () => Promise<void>;
  setSelectedModel: (model: string) => void;
}

/** 取当前模型的能力，未加载完成时按默认值（不支持多模态）处理。 */
export function getSelectedCapabilities(
  state: Pick<ModelsState, "selectedModel" | "capabilities">,
): ModelCapabilities {
  return (
    state.capabilities[state.selectedModel] ??
    resolveModelCapabilities(state.selectedModel)
  );
}

// 全局共用一个请求，多个组件同时调用时不会重复拉取
let inflight: Promise<void> | null = null;

interface GatewayModel {
  id?: string;
  /** 网关声明的输入模态，例如 ["text", "image"]；不同网关可能缺失 */
  input_modalities?: string[];
}

export const useModelsStore = create<ModelsState>()(
  persist(
    (set, get) => ({
      models: [],
      capabilities: {},
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
          .then((data: { data?: GatewayModel[] }) => {
            const items = (data?.data ?? []).filter(
              (item): item is GatewayModel & { id: string } => !!item.id,
            );
            const models = items.map((item) => item.id).sort();
            const capabilities: Record<string, ModelCapabilities> = {};
            for (const item of items) {
              capabilities[item.id] = resolveModelCapabilities(
                item.id,
                item.input_modalities,
              );
            }
            const selected = get().selectedModel;
            set({
              models,
              capabilities,
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
