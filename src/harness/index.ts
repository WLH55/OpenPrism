// OpenPrism harness 公共出口（设计 §9）。

export type { PlatformEnv, EnvFetch, EnvFetchRequest, EnvFetchResponse, EnvReadableStream, FileIO } from "./env";
export type {
  ContentBlock,
  TextBlock,
  ToolCallBlock,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Usage,
  JsonSchema,
} from "./types";
export { fnv1a } from "./util";

export * from "./session/events";
export { InMemorySessionLog, JsonlSessionLog, type SessionLog } from "./session/log";
export {
  projectSurface,
  deriveMessages,
  summaryCheckpointMessage,
  DEFAULT_PRUNE,
  PRUNE_PLACEHOLDER,
  type PruneConfig,
  type SurfaceItem,
} from "./session/project";
export { countTurns, currentGeneration, retryBudgetUsed, lastRequestHeader } from "./session/queries";

export type { LlmAdapter, LlmRequest, LlmResponse, LlmCallOptions, LlmEmbeddingRequest, LlmEmbeddingResponse, ToolPublicSchema } from "./llm/adapter";
export {
  llmFailure,
  isLlmFailure,
  looksLikeContextOverflow,
  looksLikeQuota,
  isAbortLike,
  type LlmFailure,
  type LlmFailureCode,
} from "./llm/errors";
export { createOpenAICompatAdapter, type OpenAICompatConfig } from "./llm/openai-compat";
export { createMockLlmAdapter, type MockScriptStep, type MockLlmAdapter } from "./llm/mock";

export { withRetry, computeRetryDelayMs, DEFAULT_RETRY_POLICY, type RetryPolicy, type WithRetryDeps } from "./retry/retry";

export { ToolRegistry, type ToolDefinition, type ToolRunContext } from "./tools/registry";
export { runToolCalls, type RunToolCallsDeps, type RunToolCallsResult, type ToolRunOutcome } from "./tools/pipeline";
export { validateAgainstJsonSchema } from "./tools/schema";

export {
  heuristicTextTokens,
  heuristicMessageTokens,
  heuristicRequestTokens,
  codePointLength,
} from "./context/meter";
export {
  compactConversation,
  selectShadowInterval,
  DEFAULT_COMPACTION,
  type CompactionConfig,
  type CompactDeps,
  type CompactOptions,
  type CompactResult,
} from "./context/compact";

export type { AgentLiveEvent } from "./core/events";
export { createAgent, type Agent, type AgentConfig, type AgentModelConfig } from "./core/agent";
