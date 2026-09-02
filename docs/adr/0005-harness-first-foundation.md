# Harness 先行：先复刻 dsh harness，再重新做功能与 UI 设计

已交付的 OpenPrism App 设计（批次 0-2，见 ADR 0004）整体作废，代码保留在 git 历史（HEAD 0490371）不删档。新的次序是：先把 dsh（DeepSeek Harness）的 harness 能力完整复刻为独立地基（机制照抄、不引入其 Cordis 插件架构），在其之上重新做功能设计与 UI 设计，最后才开发。唯一确定保留的未来能力需求是定时任务（无头执行）；harness 因此必须 runtime 无关（宿主 App 尚未设计）且工具集未知（只定义 ToolDefinition 契约，不绑定具体领域工具）。
