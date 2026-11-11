/**
 * This file defines the tools available to the ReAct agent.
 * Tools are functions that the agent can use to interact with external systems or perform specific tasks.
 */
import { TavilySearch } from "@langchain/tavily";
import { tool } from "@langchain/core/tools";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { addMemory } from "./long-term.js";

/**
 * Tavily search tool configuration
 * This tool allows the agent to perform web searches using the Tavily API.
 */
const searchTavily = new TavilySearch({
  maxResults: 3,
});

/**
 * 长期记忆写入工具。
 * 从 configurable.userId 取用户维度，未传入时归到 default 桶。
 */
const remember = tool(
  async ({ content }, config?: RunnableConfig) => {
    const userId =
      (config?.configurable?.userId as string | undefined) || "default";
    const record = await addMemory(userId, content);
    return `已写入长期记忆：${record.content}`;
  },
  {
    name: "remember",
    description:
      "把用户的长期信息写入记忆，跨会话保留。适用于身份、职业、稳定偏好、习惯、长期目标，" +
      "或用户明确要求你记住的事情。不要记录一次性需求、闲聊细节或工具返回的数据。",
    schema: z.object({
      content: z
        .string()
        .describe(
          "一条可以独立理解的事实，用第三人称陈述。例如：用户是一名前端工程师，主要使用 TypeScript 和 React。",
        ),
    }),
  },
);

/**
 * Export an array of all available tools
 * Add new tools to this array to make them available to the agent
 *
 * Note: You can create custom tools by implementing the Tool interface from @langchain/core/tools
 * and add them to this array.
 * See https://js.langchain.com/docs/how_to/custom_tools/#tool-function for more information.
 */
export const TOOLS = [searchTavily, remember];
