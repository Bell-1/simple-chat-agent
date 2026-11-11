# Simple Chat Agent

一个基于 LangGraph + React 的智能体对话平台，支持流式输出、思考过程与工具调用可视化、多轮会话管理以及运行时模型切换。

> 用于探索「Agent 运行时 + 现代化聊天前端」的完整落地方式。

## 功能特性

**对话与流式**
- 基于 SSE 的逐字流式输出，消息列表自动吸附底部，支持中断与停止生成
- Markdown 渲染，支持代码高亮与 KaTeX 公式
- 消息级复制；多分支回答可左右切换（Branch Switcher）
- 重新生成：基于该条回答的父检查点重跑，原回答保留为旧分支
- 新建分支会话：把截至当前消息的历史复制到新会话，原会话不受影响

**用量与时间**
- 每条对话底部展示该轮实际消耗：总 tokens（输入 / 输出 / 缓存命中）
- 用量取自模型接口原样返回的 `usage`，缺失时回退 LangChain 的 `usage_metadata`
- 缓存命中兼容 DeepSeek（`prompt_cache_hit_tokens`）与 OpenAI（`prompt_tokens_details.cached_tokens`）
- 同一条消息还会展示服务端写入的 `created_at` 接收时间

**过程可视化**
- 「思考过程」与「工具调用」统一收进一个外层折叠面板，默认收起，标题实时显示当前状态
- 工具汇总按「一轮对话」聚合统计（同一问题下模型多轮调用的工具会合并计数）
- 每个工具调用单独折叠，展示调用参数、执行结果与 `pending / running / success / error` 状态
- 工具执行结果内联在对应调用块中，不再单独渲染冗余消息
- 可一键隐藏全部工具调用，只看最终回答

**会话管理**
- 会话列表、历史会话加载、删除与重命名
- 会话标题实时同步，支持按会话 ID 深链接（`?threadId=...`）
- 切换会话或刷新页面时自动重连未完成的运行（`reconnectOnMount`）

**记忆与上下文**
- 短期记忆：按 token 预算构建上下文，滑出窗口的历史增量折叠成滚动摘要
- 长期记忆：按最后一条用户消息做关键词相关性检索，注入系统提示词
- 上下文精简：最近 6 轮全量保留 + 早期相关轮次召回 + 闲聊轮次折叠 + 工具结果去重与截断
- 任何裁剪都只作用于「发给模型的上下文」，检查点里的完整历史不受影响

**模型能力**
- 输入框右下角可切换模型，模型清单通过 OpenAI 兼容的 `/models` 接口实时获取
- 模型列表全局共享并持久化到 `localStorage`，切换后随每次请求透传给后端
- 后端通过 `configurable.model` 热切换底层 LLM，无需重启服务
- 能力标注：自动识别模型是否支持图片，下拉与选中态会显示「支持图片」

**图片与附件**
- 输入框左侧「+」菜单分开提供「上传图片 / 上传文件」，同时支持拖拽与粘贴上传
- 单次最多 5 个附件，上传中/解析中/已就绪/失败状态实时展示在输入区
- 文档解析：PDF、Word、Excel、TXT / Markdown / CSV；音视频走转写（视频需本机 `ffmpeg`）
- 图片直接作为多模态输入（转 data URL 发给模型），文档解析文本按预算注入上下文
- 消息内可直接预览图片、查看文件卡片；刷新、切会话、重新生成后附件仍可访问
- 对象存储直传：支持 Cloudflare R2（S3 兼容），未配置时自动退化为本地磁盘

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 前端框架 | React 19 + TypeScript + Vite |
| 样式与组件 | Tailwind CSS v4 + shadcn/ui（Radix UI）+ framer-motion |
| 状态与路由 | Zustand（含 persist）+ React Router v7 + nuqs |
| 流式接入 | `@langchain/langgraph-sdk` 的 `useStream`（SSE） |
| Agent 运行时 | LangGraph JS（StateGraph + ToolNode + ReAct 循环） |
| 模型接入 | `@langchain/openai` 兼容任意 OpenAI 协议网关（示例使用 DeepSeek） |
| 对象存储 | Cloudflare R2 / S3 兼容（`@aws-sdk/client-s3` 预签名直传），本地磁盘兜底 |
| 文件解析 | `pdf-parse`、`mammoth`、`exceljs`；音视频转写经网关 `/audio/transcriptions` |
| 工具能力 | `@langchain/tavily` 联网搜索 |
| 工程化 | pnpm workspace + Turborepo + ESLint + Prettier |

## 项目结构

```
.
├── apps
│   ├── web                     # 前端应用（Vite + React）
│   │   └── src
│   │       ├── components/thread   # 会话列表、消息渲染、消息操作栏、附件交互
│   │       ├── lib                 # 上传客户端、模型能力解析等
│   │       ├── providers           # Stream / Thread 上下文
│   │       └── stores              # Zustand：模型列表、工具调用开关
│   └── agents                  # Agent 运行时（LangGraph JS）
│       └── src
│           ├── react-agent         # 主图：ReAct + 工具调用 + 短期/长期记忆
│           │   ├── graph.ts        # 图定义与 callModel（含附件注入）
│           │   ├── attachments.ts  # 图片转 data URL、文档文本注入
│           │   ├── context.ts      # 发送侧上下文裁剪（召回 / 折叠 / 降级）
│           │   ├── short-term.ts   # token 计数与滚动摘要
│           │   └── long-term.ts    # 长期记忆存储与检索
│           ├── uploads             # 独立上传服务（签名、解析、读取）
│           │   ├── server.ts       # HTTP 服务，默认 2025 端口
│           │   ├── storage.ts      # R2 / S3 / 本地磁盘驱动
│           │   └── parse/          # PDF / Word / Excel / 音视频解析
├── model-capabilities.json     # 前后端共用的模型能力配置（视觉 / 音频）
├── langgraph.json              # 图与运行环境注册
└── .env                        # 统一环境变量（后端与前端代理共用）
```

前端通过 `/threads`、`/runs/stream` 等接口与 LangGraph dev server 通信；开发期 `/openai/*` 与 `/uploads/*` 由 Vite 代理转发到模型网关与上传服务，API Key 与存储凭证只存在于本地环境变量中，不会打进浏览器包。

## 快速开始

环境要求：Node.js >= 20、pnpm 10；需要解析视频时安装 `ffmpeg`。

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 至少填入 OPENAI_API_KEY；使用联网搜索时再填 TAVILY_API_KEY
# 需要云端附件存储时填写 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY

# 3. 启动（前端 5173 + Agent 运行时 2024 + 上传服务 2025）
pnpm dev
```

打开 http://localhost:5173 即可开始对话。

也可以分别启动：

```bash
pnpm turbo dev --filter=web      # 仅前端
pnpm turbo dev --filter=agents   # 仅 Agent 运行时
pnpm --filter agents dev:upload  # 仅附件上传服务
```

> 使用 R2 直传时，需要给 bucket 配置 CORS：允许前端源（如 `http://localhost:5173`）的 `GET / PUT / HEAD` 与 `Content-Type` 请求头。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI 兼容网关的 API Key |
| `OPENAI_BASE_URL` / `OPENAI_API_BASE` | 网关地址，例如 `https://api.deepseek.com` |
| `TAVILY_API_KEY` | Tavily 联网搜索 Key |
| `UPLOAD_PORT` | 附件上传服务端口，默认 `2025`（前端代理需一致） |
| `R2_ACCOUNT_ID` / `R2_BUCKET` | Cloudflare R2 账号与桶名 |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 的 S3 凭证（对象读写权限） |
| `R2_PUBLIC_BASE_URL` | 可选，桶绑定的公开域名；不填则图片用预签名地址 |
| `UPLOAD_URL_EXPIRES` | 可选，预签名有效期（秒），默认 7 天 |
| `LANGSMITH_API_KEY` 等 | 可选，用于 LangSmith 追踪调试 |

> 项目对模型网关只要求「OpenAI 协议兼容」：只要网关提供 `/chat/completions` 与 `/models`，把地址和 Key 填进环境变量即可，无需改代码。音频转写额外依赖网关提供 `/audio/transcriptions`。

**模型能力配置**

`model-capabilities.json` 由前后端共用，决定某个模型是否支持图片 / 音频输入。解析优先级：`models` 精确匹配 > 网关 `/models` 返回的 `input_modalities` > `patterns` 正则 > `defaults`。修改后需重启对应服务生效。

## 实现要点

**1. 思考内容的完整透传**

LangGraph dev server 在注入 token 流式回调后，会让 `ChatOpenAI` 走流式转换路径，而默认实现会丢弃网关返回的 `reasoning_content`。这里通过继承 `ChatOpenAICompletions` 并重写消息/增量转换方法，把推理内容落到 `additional_kwargs.reasoning_content`，前端即可稳定渲染「思考过程」，非流式响应也做了同样的兼容兜底。

**2. 按轮次聚合的工具展示**

一轮提问内模型可能连续多次调用工具（例如先并行 2 个、再补 1 个），若按单条 AI 消息统计会出现「调用了 3 次却显示 2 个」的问题。前端以两条用户消息为边界切分轮次，聚合该轮所有工具调用后挂在首条 AI 消息上展示，并合并工具结果映射，保证计数与状态一致。

**3. 流式状态判定**

最后一条 AI 消息之后可能还跟着工具结果消息，因此「是否正在流式」按最后一条 AI 消息判定，而不是消息列表末尾，避免工具执行阶段思考面板反复闪烁。

**4. 前端不接触密钥**

模型列表请求走 Vite 代理，由 dev server 注入 `Authorization` 头；生产环境替换为后端网关转发即可。

**5. 只在「发送侧」做上下文压缩**

checkpoint 保存全量历史，`callModel` 每次只决定发给模型的内容，二者解耦后可以任意裁剪而不破坏历史。裁剪分三层：最近 6 轮固定保留；更早的轮次按中文二元组关键词打分，召回相关度最高的 3 轮；剩余轮次交给滚动摘要，不会真正丢失信息。工具结果做完全重复去重与非最新长结果截断（200 字），闲聊轮次先用规则初筛、再批量交给一次轻量模型调用确认后折叠。

**6. 提示词前缀稳定以命中缓存**

系统提示词位于请求最前，任何逐轮变化都会让服务端前缀缓存全部失效。因此提示词中不含时间等动态内容，当前时间改由消息的 `created_at` 在前端展示。实测同一会话第二轮起缓存命中率约 91%。

**7. 附件走独立上传服务，与对话图解耦**

上传、签名与解析放在独立进程（默认 2025），不把存储凭证与二进制流塞进 LangGraph 运行时。流程为：前端申请签名 → 直传对象存储（或本地磁盘）→ 完成回调触发异步解析 → 解析文本单独落 `parsed/<id>.txt`。对话图只在 `callModel` 前读取最新一条用户消息的附件元数据：图片经服务内部读取转成 data URL 作为多模态输入，文档注入解析文本并在 2 万字符预算内截断；模型不支持视觉时降级为文字占位。附件元数据写入 `additional_kwargs.attachments` 随 checkpoint 持久化，因此刷新、切会话、重新生成与新建分支都能复用。token 统计时图片按 `IMAGE_TOKEN_ESTIMATE` 估算。

## Roadmap

- [x] 附件与图片输入（R2 / 本地存储、文档解析、视觉输入）
- [ ] 音频 / 视频转写接入支持 `/audio/transcriptions` 的网关
- [ ] 会话搜索与分组
- [ ] 更多内置工具（文件、数据库、浏览器）
- [ ] 生产部署编排（鉴权、限流、可观测性）

