# 复刻范围：机制全量，策略外围排除

dsh 的 harness 能力按七组划定复刻边界：循环机器（turn/step、三通道收件箱、abort 保留部分输出）、错误与重试（LlmFailure 码表、退避+抖动+Retry-After、持久化预算）、上下文管理（token 计量、压力、两阶段压缩、replaceGeneration）、工具管线（超时、isError 归一、canonical JSON + schema 校验、并发调度）、会话持久化（model-visible means logged，粒度降为消息级）、请求组装（配置档案、请求前拦截回调）——六组全量复刻，落地为直接函数注入/回调而非 Cordis 插件瀑布。审批、沙箱、fs 写意图门、subagent、agent teams、Code Mode 排除：它们服务于「agent 可执行任意代码」的威胁模型，当前不存在该威胁。回访条件：功能设计阶段若出现任意代码/命令执行类工具，必须回来补审批与沙箱。
