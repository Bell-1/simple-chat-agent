# Simple Chat Agent

一个基于 LangGraph + React 的智能体对话平台，支持流式输出、思考过程与工具调用可视化、多轮会话管理以及运行时模型切换。

> 用于探索「Agent 运行时 + 现代化聊天前端」的完整落地方式。

## 功能特性

**对话与流式**
- 基于 SSE 的逐字流式输出，消息列表自动吸附底部，支持中断与停止生成
- Markdown 渲染，支持代码高亮与 KaTeX 公式
- 消息级复制；多分支回答可左右切换（Branch Switcher）

**过程可视化**
- 「思考过程」与「工具调用」统一收进一个外层折叠面板，默认收起，标题实时显示当前状态
- 工具汇总按「一轮对话」聚合统计（同一问题下模型多轮调用的工具会合并计数）
- 每个工具调用单独折叠，展示调用参数、执行结果与 `pending / running / success / error` 状态
- 工具执行结果内联在对应调用块中，不再单独渲染冗余消息
- 可一键隐藏全部工具调用，只看最终回答

**会话管理**
- 会话列表、历史会话加载、删除与重命名
- 会话标题实时同步，支持按会话 ID 深链接（`?threadId=...`）

**模型能力**
- 输入框右下角可切换模型，模型清单通过 OpenAI 兼容的 `/models` 接口实时获取
- 模型列表全局共享并持久化到 `localStorage`，切换后随每次请求透传给后端
- 后端通过 `configurable.model` 热切换底层 LLM，无需重启服务

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 前端框架 | React 19 + TypeScript + Vite |
| 样式与组件 | Tailwind CSS v4 + shadcn/ui（Radix UI）+ framer-motion |
| 状态与路由 | Zustand（含 persist）+ React Router v7 + nuqs |
| 流式接入 | `@langchain/langgraph-sdk` 的 `useStream`（SSE） |
| Agent 运行时 | LangGraph JS（StateGraph + ToolNode + ReAct 循环） |
| 模型接入 | `@langchain/openai` 兼容任意 OpenAI 协议网关（示例使用 DeepSeek） |
| 工具能力 | `@langchain/tavily` 联网搜索，另有检索 / 索引 / 记忆类示例图 |
| 工程化 | pnpm workspace + Turborepo + ESLint + Prettier |

## 项目结构

```
.
├── apps
│   ├── web                     # 前端应用（Vite + React）
│   │   └── src
│   │       ├── components/thread   # 会话列表、消息渲染、消息操作栏
│   │       ├── providers           # Stream / Thread 上下文
│   │       └── stores              # Zustand：模型列表、工具调用开关
│   └── agents                  # Agent 运行时（LangGraph JS）
│       └── src
│           ├── react-agent         # 主图：ReAct + 工具调用
│           ├── memory-agent        # 带长期记忆的示例图
│           ├── research-agent      # 检索 / 索引示例图
│           └── retrieval-agent     # 检索问答示例图
├── langgraph.json              # 图与运行环境注册
└── .env                        # 统一环境变量（后端与前端代理共用）
```

前端通过 `/threads`、`/runs/stream` 等接口与 LangGraph dev server 通信；开发期 `/openai/*` 由 Vite 代理转发到模型网关，API Key 只存在于本地环境变量中，不会打进浏览器包。

## 快速开始

环境要求：Node.js >= 20、pnpm 10。

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 至少填入 OPENAI_API_KEY；使用联网搜索时再填 TAVILY_API_KEY

# 3. 启动（前端 5173 + Agent 运行时 2024）
pnpm dev
```

打开 http://localhost:5173 即可开始对话。

也可以分别启动：

```bash
pnpm turbo dev --filter=web      # 仅前端
pnpm turbo dev --filter=agents   # 仅 Agent 运行时
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI 兼容网关的 API Key |
| `OPENAI_BASE_URL` / `OPENAI_API_BASE` | 网关地址，例如 `https://api.deepseek.com` |
| `TAVILY_API_KEY` | Tavily 联网搜索 Key |
| `LANGSMITH_API_KEY` 等 | 可选，用于 LangSmith 追踪调试 |
| `MONGODB_URI` / `PINECONE_*` / `COHERE_API_KEY` / `ELASTICSEARCH_*` | 记忆与检索类示例图使用 |

> 项目对模型网关只要求「OpenAI 协议兼容」：只要网关提供 `/chat/completions` 与 `/models`，把地址和 Key 填进环境变量即可，无需改代码。

## 实现要点

**1. 思考内容的完整透传**

LangGraph dev server 在注入 token 流式回调后，会让 `ChatOpenAI` 走流式转换路径，而默认实现会丢弃网关返回的 `reasoning_content`。这里通过继承 `ChatOpenAICompletions` 并重写消息/增量转换方法，把推理内容落到 `additional_kwargs.reasoning_content`，前端即可稳定渲染「思考过程」，非流式响应也做了同样的兼容兜底。

**2. 按轮次聚合的工具展示**

一轮提问内模型可能连续多次调用工具（例如先并行 2 个、再补 1 个），若按单条 AI 消息统计会出现「调用了 3 次却显示 2 个」的问题。前端以两条用户消息为边界切分轮次，聚合该轮所有工具调用后挂在首条 AI 消息上展示，并合并工具结果映射，保证计数与状态一致。

**3. 流式状态判定**

最后一条 AI 消息之后可能还跟着工具结果消息，因此「是否正在流式」按最后一条 AI 消息判定，而不是消息列表末尾，避免工具执行阶段思考面板反复闪烁。

**4. 前端不接触密钥**

模型列表请求走 Vite 代理，由 dev server 注入 `Authorization` 头；生产环境替换为后端网关转发即可。

## Roadmap

- [ ] 附件与图片输入
- [ ] 会话搜索与分组
- [ ] token 用量与费用统计
- [ ] 更多内置工具（文件、数据库、浏览器）
- [ ] 生产部署编排（鉴权、限流、可观测性）

