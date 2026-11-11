/**
 * Define the configurable parameters for the agent.
 */
import { Annotation } from "@langchain/langgraph";
import { SYSTEM_PROMPT_TEMPLATE } from "./prompts.js";
import { DEFAULT_MAX_CONTEXT_TOKENS } from "./short-term.js";
import { RunnableConfig } from "@langchain/core/runnables";

export const ConfigurationSchema = Annotation.Root({
  /**
   * The system prompt to be used by the agent.
   */
  systemPromptTemplate: Annotation<string>,

  /**
   * The name of the language model to be used by the agent.
   */
  model: Annotation<string>,

  /** 短期记忆：发给模型的历史消息 token 预算。 */
  maxContextTokens: Annotation<number>,

  /** 长期记忆的归属用户，用于隔离不同用户的记忆。 */
  userId: Annotation<string>,
});

export function ensureConfiguration(
  config: RunnableConfig,
): typeof ConfigurationSchema.State {
  /**
   * Ensure the defaults are populated.
   */
  const configurable = config.configurable ?? {};
  const model = configurable.model;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(
      "未选择模型：模型名需由前端从模型列表中选择后通过 configurable.model 传入。",
    );
  }

  return {
    systemPromptTemplate:
      configurable.systemPromptTemplate ?? SYSTEM_PROMPT_TEMPLATE,
    model,
    maxContextTokens:
      typeof configurable.maxContextTokens === "number" &&
      configurable.maxContextTokens > 0
        ? configurable.maxContextTokens
        : DEFAULT_MAX_CONTEXT_TOKENS,
    userId:
      typeof configurable.userId === "string" &&
      configurable.userId.trim().length > 0
        ? configurable.userId
        : "default",
  };
}
