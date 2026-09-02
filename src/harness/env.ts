// 平台能力注入（设计 §2）：核心代码零平台依赖，宿主能力全部从这里进来。
// Node / RN / 浏览器各自提供一份实现即可运行同一份 harness。

export interface EnvFetchRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface EnvReadableStream {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
}

export interface EnvFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: EnvReadableStream;
}

export type EnvFetch = (input: string, init?: EnvFetchRequest) => Promise<EnvFetchResponse>;

export interface PlatformEnv {
  fetch: EnvFetch;
  now(): number;
  randomUUID(): string;
}

// JSONL 会话日志的文件 IO 注入面（设计 §7.2）。
export interface FileIO {
  appendLine(path: string, line: string): Promise<void>;
  readAll(path: string): Promise<string[]>;
}
