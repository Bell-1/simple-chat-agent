import { AIMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  MessagesAnnotation,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { ConfigurationSchema, ensureConfiguration } from "./configuration.js";
import { TOOLS } from "./tools.js";
import { loadChatModel, attachReasoning } from "./utils.js";
import {
  formatSummary,
  getLatestHumanText,
  updateSummary,
} from "./short-term.js";
import { buildContext } from "./context.js";
import {
  enrichLatestHumanMessage,
  getMessageAttachments,
} from "./attachments.js";
import { getModelCapabilities } from "./model-capabilities.js";
import { formatMemories, searchMemories } from "./long-term.js";

/**
 * 在 MessagesAnnotation 基础上增加短期记忆的滚动摘要字段。
 */
const StateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** 已折叠历史的滚动摘要 */
  shortTermSummary: Annotation<string>({
    reducer: (_prev, next) => next ?? "",
    default: () => "",
  }),
  /** 摘要已覆盖到的最后一条消息 id，用于增量摘要 */
  shortTermSummaryUpTo: Annotation<string>({
    reducer: (_prev, next) => next ?? "",
    default: () => "",
  }),
});

// Define the function that calls the model
async function callModel(
  state: typeof StateAnnotation.State,
  config: RunnableConfig,
): Promise<typeof StateAnnotation.Update> {
  /** Call the LLM powering our agent. **/
  const configuration = ensureConfiguration(config);

  // Feel free to customize the prompt, model, and other logic!
  const model = (await loadChatModel(configuration.model)).bindTools(TOOLS);

  const query = getLatestHumanText(state.messages);

  // 长期记忆：按最后一条用户消息检索相关记忆，注入系统提示词
  const memories = await searchMemories(configuration.userId, query);

  // 短期记忆：时间窗口 + 相关性筛选 + 内容降级，滑出窗口的历史折叠成滚动摘要
  const { context, older } = await buildContext(state.messages, {
    maxContextTokens: configuration.maxContextTokens,
    query,
    modelName: configuration.model,
  });
  const { summary, summaryUpTo } = await updateSummary({
    older,
    summary: state.shortTermSummary,
    summaryUpTo: state.shortTermSummaryUpTo,
    modelName: configuration.model,
  });

  const systemPrompt =
    configuration.systemPromptTemplate +
    formatSummary(summary) +
    formatMemories(memories);

  // 附件：最新一条人类消息里的图片转 data URL，文档/音视频注入解析文本
  let modelMessages = context;
  const hasAttachments = context.some(
    (message) =>
      message.type === "human" && getMessageAttachments(message).length > 0,
  );
  if (hasAttachments) {
    const capabilities = await getModelCapabilities(configuration.model);
    modelMessages = await enrichLatestHumanMessage(context, capabilities);
  }

  const response = await model.invoke([
    { role: "system", content: systemPrompt },
    ...modelMessages,
  ]);

  // 记录模型响应的接收时间，供前端在消息底部展示
  const aiMessage = attachReasoning(response);
  aiMessage.additional_kwargs = {
    ...aiMessage.additional_kwargs,
    created_at: new Date().toISOString(),
  };

  // 我们返回列表，因为它会被追加到已有的消息列表
  return {
    messages: [aiMessage],
    shortTermSummary: summary,
    shortTermSummaryUpTo: summaryUpTo,
  };
}

// Define the function that determines whether to continue or not
function routeModelOutput(state: typeof StateAnnotation.State): string {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];
  // If the LLM is invoking tools, route there.
  if ((lastMessage as AIMessage)?.tool_calls?.length || 0 > 0) {
    return "tools";
  }
  // Otherwise end the graph.
  else {
    return "__end__";
  }
}

// Define a new graph. We use the prebuilt MessagesAnnotation to define state:
// https://langchain-ai.github.io/langgraphjs/concepts/low_level/#messagesannotation
const workflow = new StateGraph(StateAnnotation, ConfigurationSchema)
  // Define the two nodes we will cycle between
  .addNode("callModel", callModel)
  .addNode("tools", new ToolNode(TOOLS))
  // Set the entrypoint as `callModel`
  // This means that this node is the first one called
  .addEdge("__start__", "callModel")
  .addConditionalEdges(
    // First, we define the edges' source node. We use `callModel`.
    // This means these are the edges taken after the `callModel` node is called.
    "callModel",
    // Next, we pass in the function that will determine the sink node(s), which
    // will be called after the source node is called.
    routeModelOutput,
  )
  // This means that after `tools` is called, `callModel` node is called next.
  .addEdge("tools", "callModel");

// Finally, we compile it!
// This compiles it into a graph you can invoke and deploy.
export const graph = workflow.compile({
  interruptBefore: [], // if you want to update the state before calling the tools
  interruptAfter: [],
});
