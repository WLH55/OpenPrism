/**
 * 浏览器半边打包：esbuild CJS 转译 -> 手工包装为 dsh 客户端闭包工厂。
 *
 * 工厂契约（packages/client/modules/src/client/manifest.ts）：
 * `factory(require)` 单参数调用，返回值即 bundle 的 exports。esbuild 的 CJS
 * 输出体引用 `require("react")`（externals）与 `module.exports`（导出），
 * 因此在这里补上局部 `module`/`exports` 绑定。
 */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const result = await build({
  entryPoints: ['src/client.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: EXTERNALS,
  minify: true,
  write: false,
  logLevel: 'warning',
})

const code = result.outputFiles[0].text
const artifact = `window.__ModuleLoader__.load({ id: 'openprism/client', factory: function (require) {\nvar module = { exports: {} };\nvar exports = module.exports;\n${code}\nreturn module.exports;\n} });\n`

await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', artifact, 'utf8')
console.log(`openprism client bundle -> lib/client.js (${String(artifact.length)} bytes)`)
