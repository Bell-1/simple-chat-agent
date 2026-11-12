/**
 * This file defines the tools available to the ReAct agent.
 * Tools are functions that the agent can use to interact with external systems or perform specific tasks.
 */
import { TavilySearch } from "@langchain/tavily";
import { tool } from "@langchain/core/tools";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { addMemory } from "./long-term.js";
import { searchChunks } from "../rag/search.js";

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
 * 资料检索工具：在用户自己上传过的文件里做向量召回。
 * 返回的 artifact 会随 ToolMessage 一起进入状态，供前端渲染引用。
 */
const searchKnowledge = tool(
  async ({ query }, config?: RunnableConfig) => {
    const userId =
      (config?.configurable?.userId as string | undefined) || "default";

    let hits;
    try {
      hits = await searchChunks({ userId, query });
    } catch (error) {
      return [
        `资料检索暂不可用：${
          error instanceof Error ? error.message : String(error)
        }`,
        { citations: [] },
      ] as const;
    }

    if (hits.length === 0) {
      return [
        "未在该用户上传的资料中找到相关内容。不要凭空编造资料内容。",
        { citations: [] },
      ] as const;
    }

    const content = hits
      .map(
        (hit, index) =>
          `[${index + 1}] ${hit.sourceName} · 第 ${hit.chunkIndex + 1} 段\n${hit.content}`,
      )
      .join("\n\n");

    const citations = hits.map((hit, index) => ({
      index: index + 1,
      attachmentId: hit.attachmentId,
      sourceName: hit.sourceName,
      chunkIndex: hit.chunkIndex,
      score: Number(hit.score.toFixed(4)),
    }));

    return [content, { citations }] as const;
  },
  {
    name: "search_knowledge",
    description:
      "在用户上传过的资料（PDF、Word、Excel、文本等）中检索相关内容。" +
      "当用户提到「我之前上传的文件/资料/文档/报告/表格」、询问具体资料里的细节，" +
      "或需要基于用户私有文件回答时使用。回答时用 [1][2] 标注来源，并说明文件名。" +
      "如果检索结果为空，明确告诉用户没有找到，不要编造。",
    schema: z.object({
      query: z
        .string()
        .describe("检索问题或关键词，尽量具体，包含用户提到的对象与限定条件"),
    }),
    responseFormat: "content_and_artifact",
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
export const TOOLS = [searchTavily, remember, searchKnowledge];
