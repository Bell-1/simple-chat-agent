/**
 * Define the configurable parameters for the agent.
 */
import { Annotation } from "@langchain/langgraph";
import { SYSTEM_PROMPT_TEMPLATE } from "./prompts.js";
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
  };
}
