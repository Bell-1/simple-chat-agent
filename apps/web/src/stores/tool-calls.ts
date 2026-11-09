import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ToolCallsState {
  hideToolCalls: boolean;
  setHideToolCalls: (hideToolCalls: boolean) => void;
}

/**
 * Global UI preference, persisted to localStorage.
 * No React provider needed: any component can read/subscribe via the hook.
 */
export const useToolCallsStore = create<ToolCallsState>()(
  persist(
    (set) => ({
      hideToolCalls: false,
      setHideToolCalls: (hideToolCalls) => set({ hideToolCalls }),
    }),
    { name: "tool-calls" },
  ),
);
