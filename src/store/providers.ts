/**
 * 厂商配置（M7）：通用 OpenAI 兼容接入——{名称, baseURL, apiKey, 模型}，
 * 内置预设仅是可编辑的默认值；apiKey 存 SecureStore（系统加密存储），其余落 providers.json。
 */

import * as SecureStore from 'expo-secure-store'
import { File } from 'expo-file-system'
import { dataDir, readJsonFile, writeJsonFile } from './paths'

export interface ProviderConfig {
  id: string
  name: string
  baseURL: string
  model: string
}

export interface ResolvedProvider extends ProviderConfig {
  apiKey: string
}

export interface AppSettings {
  currentProviderId?: string
}

export const PROVIDER_PRESETS: Array<Pick<ProviderConfig, 'name' | 'baseURL' | 'model'>> = [
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
  { name: '通义 Qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-latest' },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat-v3.1' },
]

function providersFile(): File {
  return new File(dataDir(), 'providers.json')
}

function settingsFile(): File {
  return new File(dataDir(), 'settings.json')
}

function keyRef(id: string): string {
  return `openprism.key.${id}`
}

export function loadProviders(): ProviderConfig[] {
  return readJsonFile<ProviderConfig[]>(providersFile(), [])
}

export function saveProviders(list: readonly ProviderConfig[]): void {
  writeJsonFile(providersFile(), list)
}

export function loadSettings(): AppSettings {
  return readJsonFile<AppSettings>(settingsFile(), {})
}

export function saveSettings(settings: AppSettings): void {
  writeJsonFile(settingsFile(), settings)
}

export async function getApiKey(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(keyRef(id))
}

export async function setApiKey(id: string, apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(keyRef(id), apiKey)
}

export async function deleteApiKey(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyRef(id))
}

/** 当前生效厂商（配置 + 密钥齐全才返回；否则 null，对话页据此引导去设置）。 */
export async function resolveCurrentProvider(): Promise<ResolvedProvider | null> {
  const { currentProviderId } = loadSettings()
  if (!currentProviderId) return null
  const provider = loadProviders().find((p) => p.id === currentProviderId)
  if (!provider) return null
  const apiKey = await getApiKey(provider.id)
  if (!apiKey) return null
  return { ...provider, apiKey }
}

/** 连接测试：GET {baseURL}/models 验证端点与密钥。 */
export async function testProviderConnection(config: Pick<ProviderConfig, 'baseURL'>, apiKey: string): Promise<string> {
  const { fetch } = await import('expo/fetch')
  const base = config.baseURL.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) return `连接成功（HTTP ${res.status}）`
    return `端点可达但被拒绝（HTTP ${res.status}）——检查 API Key`
  } catch (e) {
    return `连不上端点：${e instanceof Error ? e.message : String(e)}`
  }
}
