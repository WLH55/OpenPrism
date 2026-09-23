# OpenPrism 架构图

> 基于分支 feat/design-standalone 当前代码。三层结构：web/ 前端、src/app/ 应用层、src/harness/ 核心库，靠两条缝连接——harness 经 PlatformEnv / FileIO / SessionLog 接口获得平台能力，前端经 HTTP + SSE 与应用层通信。

## 总体架构

```mermaid
flowchart TB
    %% ===== 前端 =====
    subgraph WEB["web/ 前端（React 18 + Vite + Tailwind）"]
        SHELL["App.tsx 应用壳（100dvh）<br/>登录门 + 视图切换<br/>桌面侧栏 / 窄屏抽屉 + 底部标签栏"]
        PAGES["Chat 聊天 · Today 今天 · Panels 盘面 · Progress 成长<br/>Agents 伙伴 · Tasks 提醒 · Skills 技能 · Memory 记忆<br/>Settings 模型接入 · NotifyChannels 通知通道 · Profile 个人资料 · Login"]
        WIZ["AgentWizard 伙伴五步向导<br/>FaceEditor 形象编辑 · soulTemplates 形象模板"]
        ATTACH["Attachments 附件托盘<br/>图片缩放转 WebP · 文本文件读成正文<br/>窄屏另有拍照直入入口"]
        MNAV["MobileNav 窄屏导航<br/>底部五项标签栏 + 左滑抽屉（安卓返回键收起）"]
        APIC["api.ts API 客户端<br/>fetch 封装 + EventSource 实时流<br/>事件分段：limit 最近 N 条 · before 向上翻页"]
        SHELL --> PAGES & WIZ & MNAV
        PAGES --> APIC & ATTACH
        WIZ --> APIC
    end

    %% ===== 应用层 =====
    subgraph APP["src/app/ 应用层（Node ≥ 22.13，唯一可碰平台 API 的层）"]
        MAIN["main.ts 进程入口：装配全部服务"]
        SRV["server.ts HTTP 路由<br/>auth · models · conversations · agents · skills · mcps<br/>memory · tasks · notifications · flows · checkin · panels · progress<br/>静态托管 web/dist（gzip 协商 + 哈希资源长缓存）<br/>events 按归属校验（非本人 404）"]
        AUTH["auth.ts 注册登录<br/>scrypt 慢哈希 + SessionStore 会话令牌"]
        SB["secretbox.ts BYOK 密封<br/>AES-256-GCM · 多供应商配置（model_providers）<br/>kind：chat / embedding · multimodal 图片识别开关"]
        CONV["conversations.ts 会话池<br/>一个会话 = 一个 harness Agent<br/>adapter 每次调用现读配置，改设置即时生效<br/>图片输入的多模态闸门（发送 / 切换 / 装配三处）"]
        ATTS["attachments.ts 附件校验<br/>图片签名与上限 · 文本附件 · 内容块构造"]
        AVA["avatar.ts 形象字段校验<br/>头像 data URL / emoji / 色盘，用户与伙伴共用"]
        SLOG["session-log.ts SqliteSessionLog<br/>SessionLog 缝的 SQLite 实现<br/>九事件落 conversation_events"]
        LEDT["tools.ts 账本录入工具<br/>record_flow / create_plan / checkin_plan<br/>query_ledger / void_flow / cancel_plan"]
        PER["persona.ts system prompt 合成<br/>人设卡 + 日期 + 记忆块 + 行为纪律"]
        AGT["agents.ts 伙伴配置<br/>persona.md + binding.json 能力绑定"]
        SKL["skills.ts 技能<br/>目录常驻 prompt · 正文按需 load_skill"]
        MCPC["mcp.ts MCP 客户端<br/>Streamable HTTP JSON-RPC"]
        MEM["memory.ts 记忆条目库<br/>kind 分类 · 词法检索"]
        MEXT["memory-extract.ts 记忆提取管线<br/>水位线推进 · 决策制蒸馏 · 整理归档<br/>90s 去抖 + 每晚 2–5 点窗口"]
        MTOP["memory-topics.ts 主题计数<br/>三级归一 · 达阈值晋升 interest"]
        MVEC["memory-vector.ts 向量召回<br/>embedding BLOB · 查询向量缓存<br/>余弦扫描 + 词法 RRF 融合 · 失败降级纯词法"]
        LG["ledger.ts 账本<br/>只追加 · 四词表 event/plan/checkin/void<br/>作废 = 追加 void 引用 seq"]
        FOLD["fold.ts 确定性折叠（0 token）<br/>todayView / categoryView / progressView"]
        TSK["tasks.ts 定时任务<br/>cron 触发器 · 补跑不补吵<br/>Scheduler 每分钟轮询"]
        NTF["notify.ts 站内通知"]
        NENV["env.ts nodeEnv / nodeFileIO<br/>平台缝的 Node 实现"]
    end

    %% ===== 核心库 =====
    subgraph HARNESS["src/harness/ 核心库（纯 TypeScript，零平台依赖）"]
        AGENT["core/agent.ts 循环机器<br/>kick→turn→step 状态机<br/>Inbox 三通道 followup / steer / inject<br/>Turn Budget · abort 保留部分输出"]
        CEV["core/events.ts 活体事件流（11 种）"]
        PROJ["session/project.ts 投影 deriveMessages<br/>遮蔽区间跳过 · 恒定裁剪超长工具结果"]
        HLOG["session/log.ts SessionLog<br/>内存 / JSONL 参考实现"]
        HQRY["session/queries.ts 日志重放恢复<br/>Turn 计数 · 替换代数 · 重试预算"]
        PIPE["tools/pipeline.ts + registry.ts 工具管线<br/>先落日志再执行 · 硬超时竞速<br/>七路失败 isError 归一 · 有界滚动池"]
        ADPT["llm/openai-compat.ts adapter<br/>SSE 流式 · 跨 chunk 工具累积 · 空闲看门狗"]
        U8["llm/utf8.ts 增量 UTF-8 解码<br/>跨 chunk 中文不截断"]
        ERR["llm/errors.ts LlmFailure 十码表"]
        RET["retry/retry.ts 指数退避<br/>Retry-After 优先 · 预算从日志恢复"]
        CMP["context/compact.ts 两阶段压缩<br/>裁剪恒在 + LLM 摘要<br/>替换代数闸溢出重试"]
        METER["context/meter.ts token 计量"]
        HENV["env.ts PlatformEnv / FileIO<br/>唯一平台注入缝"]
    end

    %% ===== 存储 =====
    subgraph DATA["data/ 运行时数据"]
        DB[("openprism.db SQLite（WAL + synchronous=FULL）<br/>users · sessions · ledger_entries · conversations<br/>conversation_events · agents · skills · mcps<br/>tasks · task_runs · notifications · archives<br/>memory_items · memory_topic_stats · memory_item_embeddings<br/>query_vectors · model_providers · model_active")]
        KEY["secret.key 主密钥（32B）"]
        LEGACY["旧版 JSONL / markdown 文件<br/>migrate.ts 一次性导入后原样保留"]
    end

    %% ===== 外部 =====
    LLM["外部 LLM 供应商（BYOK：用户自己的 baseURL + Key）<br/>chat 模型 + embedding 模型"]
    MCPS["远程 MCP 服务器"]

    %% ===== 前端 → 应用层 =====
    APIC -- "HTTP + SSE" --> SRV

    %% ===== 应用层内部 =====
    MAIN --> DB
    MAIN --> SRV & CONV & TSK & MEXT & AUTH & SB
    SRV --> AUTH & CONV & LG & FOLD & AGT & SKL & MCPC & MEM & TSK & NTF & SB & ATTS & AVA
    CONV -- "装配：工具集快照 + systemPrompt 每步重取 + adapter 现读配置" --> AGENT
    CONV --> SLOG & LEDT & PER & SKL & MCPC & MEM & ATTS
    AGT & AUTH --> AVA
    LEDT --> LG
    PER -. "读取" .-> MEM & AGT & SKL
    MEXT --> MEM & MTOP & MVEC
    TSK -- "任务专属会话 followup" --> CONV
    TSK --> NTF

    %% ===== harness 内部 =====
    AGENT --> PROJ & PIPE & RET & CMP & CEV & HQRY & METER
    AGENT -- "中立 LLM 请求" --> ADPT
    PROJ --> HLOG
    PIPE --> HLOG
    CMP -- "摘要请求复用会话前缀" --> ADPT
    MEXT & MVEC -- "LlmAdapter（BYOK）" --> ADPT
    ADPT --> U8 & ERR

    %% ===== 缝注入 =====
    HENV -. "注入" .-> AGENT & PIPE & ADPT & CMP & HLOG
    NENV -. "实现" .-> HENV
    SLOG -. "SessionLog 缝实现" .-> HLOG

    %% ===== 存储 =====
    AUTH & LG & TSK & NTF & MEM & MEXT & SB & SLOG --> DB
    SB --> KEY
    MEXT -. "首次启动迁移" .-> LEGACY

    %% ===== 外部调用 =====
    ADPT -- "PlatformEnv.fetch" --> LLM
    MCPC --> MCPS
```

## 两条缝

| 缝 | 接口 | app 层实现 | 作用 |
|---|---|---|---|
| 平台能力 | `PlatformEnv` / `FileIO`（harness/env.ts） | `app/env.ts` 的 nodeEnv / nodeFileIO | fetch、时钟、UUID、文件读写——核心库保持零平台依赖 |
| 会话日志 | `SessionLog`（harness/session/log.ts） | `app/session-log.ts` 的 SqliteSessionLog | 九事件完整原文落 SQLite，seq 崩溃重启后从库里续排 |

## 一条消息的运行时链路

```mermaid
sequenceDiagram
    participant U as 前端 Chat 页
    participant S as server.ts
    participant C as ConversationStore
    participant A as harness Agent
    participant D as SQLite (conversation_events)
    participant M as 外部 LLM (BYOK)
    participant T as 工具管线 → 账本

    U->>S: GET /api/conversations/:cid/events?limit=50（首屏最近一段）
    S->>S: 会话归属校验（非本人 404）→ 返回事件片段（seq 升序）
    U->>S: 触顶续取 ?before=<片段最小 seq>&limit=50（合并后按高度差回补滚动位置）
    U->>S: POST /api/conversations/:cid/messages（text + attachments）
    S->>S: parseAttachments 校验附件 → 内容块
    S->>C: send(uid, cid, text, 附件块)
    C->>C: 含图片且当前有效模型未开多模态 → 409（不消耗回合）
    C->>A: agent.followup(内容块)（Inbox followup 通道）
    S-->>U: 202（异步，不等回复）
    U->>S: GET /api/conversations/:cid/stream（SSE）
    S->>A: agent.subscribe → 事件实时推送
    A->>D: turn/start + user/message
    loop step（上限内）
        A->>A: 压力 ≥ 0.8×窗口 → 两阶段压缩
        A->>D: request/header（指纹变更才记）
        A->>M: complete(deriveMessages 投影 + 工具表)，失败走退避重试
        M-->>A: 流式 text-delta → SSE 推给前端
        alt 含 tool_call
            A->>D: tool/call（先落日志再执行）
            A->>T: 管线执行（超时竞速 / isError 归一）
            T->>D: tool/result
        else 纯文本
            A->>D: assistant/message
        end
    end
    A->>D: turn/end（completed / aborted / budget-exhausted …）
```

## 图片与附件

```mermaid
flowchart LR
    PICK["Chat 页选文件<br/>（图片 / 文本）"] --> CONV1["Attachments.tsx<br/>图片等比缩到长边 1280 → WebP<br/>文本按 UTF-8 解码，二进制格式拒绝"]
    CONV1 -- "多模态开关未勾选 → 就地拦下并提示" --> GATE{"当前有效模型<br/>multimodal？"}
    GATE -- 是 --> POST["POST …/messages<br/>attachments: image / file"]
    GATE -- 否 --> STOP["提示：该模型不支持图片识别<br/>文字文件仍可上传"]
    POST --> PARSE["attachments.ts 服务端复校<br/>类型 / 字节签名 / 大小 / 张数上限"]
    PARSE --> BLOCKS["内容块：text + image + file<br/>随 user/message 事件入 conversation_events"]
    BLOCKS --> WIRE["openai-compat adapter<br/>image → image_url（data URL）<br/>file → 文本段（带文件名抬头）"]
    WIRE --> MODEL["外部视觉模型"]
    BLOCKS -. "历史里有图片时" .-> SWITCH["切换模型 / 伙伴 → 409<br/>装配期请求拦截（兜底）"]
```

图片以 base64 随消息进会话日志（可重放、可跨进程重建请求），文本附件正文内联为文本块。发送、切换模型/伙伴、装配请求三处都做多模态校验：发送被拦是 409，切换被拦是 409，兜底拦截让该回合在发请求前失败并说明原因。

## 手机浏览器与静态资源

```mermaid
flowchart LR
    subgraph NARROW["窄屏（< 768px）"]
        TOPBAR["顶栏：菜单按钮 + 页名"]
        TABS["底部五项标签栏<br/>对话 · 今天 · 盘面 · 成长 · 更多"]
        DRAWER["左滑抽屉（SidebarContent 复用）<br/>最近对话 + 伙伴 + 提醒 + 设置<br/>安卓返回键收起（popstate）"]
    end
    SHELL2["App.tsx 应用壳（h-dvh）"] --> TOPBAR & TABS & DRAWER
    CHAT2["Chat 页窄屏收纳<br/>模型 / 思维链 / 切换伙伴进会话设置面板<br/>上传双入口：图片文件 + 拍照（capture）"]
    STATIC["server.ts 静态托管<br/>文本资源 gzip（Accept-Encoding 协商 + Vary）<br/>assets/* 一年 immutable · html 与 manifest 不缓存<br/>manifest.webmanifest + Prism 图标 → 添加到主屏幕"]
```

窄屏断点取 `md`（768px）：以上结构只在窄屏渲染，桌面端排版保持原样。可安装形态受传输协议限制：明文 HTTP 下浏览器只提供「添加到主屏幕」快捷方式，完整安装（独立窗口、离线缓存）需要 HTTPS（见 docs/deployment.md）。

## 记忆管线

```mermaid
flowchart LR
    CHAT["对话 / 账本 / 任务"] -- "水位线推进<br/>90s 去抖 + 每晚窗口" --> EXT["memory-extract<br/>决策制蒸馏 add / update / delete"]
    EXT --> ITEMS[("memory_items 条目库")]
    EXT -- "附带 topics" --> TOP["memory-topics<br/>精确 → 字面模糊 → 模型裁决"]
    TOP --> STATS[("memory_topic_stats")]
    STATS -- "达阈值晋升" --> ITEMS
    ITEMS -- "启动回填" --> VEC["memory-vector<br/>embedding + 查询向量缓存"]
    VEC --> EMB[("memory_item_embeddings<br/>query_vectors")]
    ITEMS & VEC -- "词法 + 向量 RRF 融合" --> INJ["persona.ts 记忆块注入<br/>+ load_memory 深查"]
    EXT -- "≥20h 一次整理" --> ARC[("archives 过期归档")]
```
