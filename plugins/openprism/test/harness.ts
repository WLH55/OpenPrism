/**
 * E2E 测试台：用最小假缝（tools / webServer / 事件总线 / logger）驱动真实的
 * `apply(ctx)`，让镜像器 → 事件日志 → 折叠 → 工具/端点的整条链路在进程内跑通。
 * 不 mock 我们的任何业务代码——只替换 dsh 宿主缝。
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export type Handler = (req: unknown, res: unknown) => Promise<void> | void

export interface FakeCtx {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  tools: { register: (def: ToolDefinition) => void }
  inject: (services: string[], cb: (ctx: WebCtx) => void) => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
  emit: (event: string, ...args: unknown[]) => void
}

export interface WebCtx {
  effect: (fn: () => () => void, name?: string) => void
  webServer: { register: (route: { kind: string; path: string; handler: Handler }) => () => void }
}

export interface TestHttpResult {
  status: number
  body: string
}

export interface Harness {
  ctx: FakeCtx
  home: string
  registered: Map<string, ToolDefinition>
  routes: Map<string, Handler>
  emit: (event: string, ...args: unknown[]) => void
  /** 向注册过的 dsh webServer 路由发一个进程内请求。 */
  request: (path: string, init?: { method?: string; body?: unknown }) => Promise<TestHttpResult>
  cleanup: () => Promise<void>
}

export async function createHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'openprism-e2e-'))
  process.env.DSH_HOME = home

  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const registered = new Map<string, ToolDefinition>()
  const routes = new Map<string, Handler>()

  const ctx: FakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(def) {
        registered.set(def.name, def)
      },
    },
    inject(services, cb) {
      if (services.includes('webServer')) {
        cb({
          effect(fn) {
            fn()
          },
          webServer: {
            register(route) {
              routes.set(route.path, route.handler)
              return () => routes.delete(route.path)
            },
          },
        })
      }
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }

  return {
    ctx,
    home,
    registered,
    routes,
    emit: (event, ...args) => ctx.emit(event, ...args),
    async request(path, init = {}) {
      const handler = routes.get(path)
      if (!handler) throw new Error(`no route: ${path}`)
      const chunks: Buffer[] = init.body !== undefined ? [Buffer.from(JSON.stringify(init.body))] : []
      const req = {
        method: init.method ?? 'GET',
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
      let status = 0
      let body = ''
      const res = {
        writeHead(code: number) {
          status = code
        },
        end(text?: string) {
          body = text ?? ''
        },
      }
      await handler(req, res)
      return { status, body }
    },
    async cleanup() {
      delete process.env.DSH_HOME
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

/** 等镜像器/内部 fire-and-forget 的 append 全部落定。 */
export function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/** 轮询等待事件日志文件包含指定内容（fs 写盘跨线程池，立即读会竞态）。 */
export async function waitForFile(path: string, contains: string, timeout = 3000): Promise<string> {
  const start = Date.now()
  let text = ''
  while (Date.now() - start < timeout) {
    try {
      text = await readFile(path, 'utf8')
      if (text.includes(contains)) return text
    } catch {
      // 文件尚未创建
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`waitForFile 超时（${contains}）；现有内容：${text.slice(0, 400)}`)
}
