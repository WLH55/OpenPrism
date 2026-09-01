/**
 * 厂商设置屏（M7）：通用 OpenAI 兼容——名称 / baseURL / API Key（SecureStore）/ 模型，
 * 内置预设只是可编辑的起手值；支持多厂商保存与一键切换当前。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { randomUUID } from 'expo-crypto'
import {
  PROVIDER_PRESETS,
  deleteApiKey,
  getApiKey,
  loadProviders,
  loadSettings,
  saveProviders,
  saveSettings,
  setApiKey,
  testProviderConnection,
  type ProviderConfig,
} from '../store/providers'

interface Draft {
  id?: string
  name: string
  baseURL: string
  model: string
  apiKey: string
  /** 编辑既有厂商时密钥留空 = 沿用已存密钥。 */
  keepKey: boolean
}

const EMPTY_DRAFT: Draft = { name: '', baseURL: '', model: '', apiKey: '', keepKey: false }

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [currentId, setCurrentId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)

  useEffect(() => {
    setProviders(loadProviders())
    setCurrentId(loadSettings().currentProviderId)
  }, [])

  const edit = useCallback((p: ProviderConfig) => {
    setDraft({ id: p.id, name: p.name, baseURL: p.baseURL, model: p.model, apiKey: '', keepKey: true })
  }, [])

  const save = useCallback(async () => {
    if (!draft.name.trim() || !draft.baseURL.trim() || !draft.model.trim()) {
      Alert.alert('缺字段', '名称、baseURL、模型名都要填')
      return
    }
    let key = draft.apiKey.trim()
    if (!key && draft.keepKey && draft.id) key = (await getApiKey(draft.id)) ?? ''
    if (!key) {
      Alert.alert('缺 API Key', 'API Key 必填（编辑时留空则沿用已保存的）')
      return
    }
    const id = draft.id ?? randomUUID()
    const config: ProviderConfig = {
      id,
      name: draft.name.trim(),
      baseURL: draft.baseURL.trim().replace(/\/+$/, ''),
      model: draft.model.trim(),
    }
    const next = draft.id
      ? providers.map((p) => (p.id === id ? config : p))
      : [...providers, config]
    saveProviders(next)
    setProviders(next)
    await setApiKey(id, key)
    if (!currentId) {
      saveSettings({ currentProviderId: id })
      setCurrentId(id)
    }
    setDraft(EMPTY_DRAFT)
    Alert.alert('已保存', `${config.name} 已就绪`)
  }, [draft, providers, currentId])

  const test = useCallback(async () => {
    if (!draft.baseURL.trim()) {
      Alert.alert('先填 baseURL', '测试需要端点地址')
      return
    }
    let key = draft.apiKey.trim()
    if (!key && draft.keepKey && draft.id) key = (await getApiKey(draft.id)) ?? ''
    if (!key) {
      Alert.alert('缺 API Key', '先填 API Key 再测试')
      return
    }
    const message = await testProviderConnection({ baseURL: draft.baseURL.trim() }, key)
    Alert.alert('连接测试', message)
  }, [draft])

  const use = useCallback((p: ProviderConfig) => {
    saveSettings({ currentProviderId: p.id })
    setCurrentId(p.id)
  }, [])

  const remove = useCallback(async (p: ProviderConfig) => {
    Alert.alert(`删除 ${p.name}?`, '配置与已存密钥一并删除', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          const next = providers.filter((x) => x.id !== p.id)
          saveProviders(next)
          setProviders(next)
          await deleteApiKey(p.id)
          if (currentId === p.id) {
            saveSettings({})
            setCurrentId(undefined)
          }
          if (draft.id === p.id) setDraft(EMPTY_DRAFT)
        },
      },
    ])
  }, [providers, currentId, draft])

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable hitSlop={12} onPress={onBack}>
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.title}>模型接入</Text>
        <View style={{ width: 44 }} />
      </View>

      <Text style={styles.section}>当前使用</Text>
      {providers.length === 0 ? (
        <Text style={styles.empty}>还没有配置厂商——用下面的预设或自填接入任意 OpenAI 兼容服务。</Text>
      ) : (
        providers.map((p) => (
          <View key={p.id} style={[styles.card, p.id === currentId && styles.cardActive]}>
            <Pressable style={styles.cardMain} onPress={() => use(p)}>
              <Text style={styles.cardName}>
                {p.id === currentId ? '● ' : '○ '}
                {p.name}
              </Text>
              <Text style={styles.cardMeta}>
                {p.model} · {p.baseURL}
              </Text>
            </Pressable>
            <Pressable hitSlop={8} style={styles.cardBtn} onPress={() => edit(p)}>
              <Text style={styles.cardBtnText}>编辑</Text>
            </Pressable>
            <Pressable hitSlop={8} style={styles.cardBtn} onPress={() => remove(p)}>
              <Text style={[styles.cardBtnText, { color: '#b3261e' }]}>删除</Text>
            </Pressable>
          </View>
        ))
      )}

      <Text style={styles.section}>{draft.id ? '编辑厂商' : '新增厂商'}</Text>
      <View style={styles.card}>
        <Text style={styles.presetLabel}>预设（点一下填入，可改）</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
          {PROVIDER_PRESETS.map((p) => (
            <Pressable
              key={p.name}
              style={styles.presetChip}
              onPress={() =>
                setDraft((d) => ({ ...d, name: p.name, baseURL: p.baseURL, model: p.model }))
              }
            >
              <Text style={styles.presetChipText}>{p.name}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Field label="名称" value={draft.name} onChangeText={(name) => setDraft((d) => ({ ...d, name }))} placeholder="如 DeepSeek" />
        <Field
          label="baseURL"
          value={draft.baseURL}
          onChangeText={(baseURL) => setDraft((d) => ({ ...d, baseURL }))}
          placeholder="https://api.deepseek.com"
          autoCapitalize="none"
        />
        <Field
          label="模型"
          value={draft.model}
          onChangeText={(model) => setDraft((d) => ({ ...d, model }))}
          placeholder="deepseek-chat"
          autoCapitalize="none"
        />
        <Field
          label={`API Key${draft.keepKey ? '（留空沿用已保存）' : ''}`}
          value={draft.apiKey}
          onChangeText={(apiKey) => setDraft((d) => ({ ...d, apiKey }))}
          placeholder="sk-…"
          secureTextEntry
          autoCapitalize="none"
        />
        <View style={styles.btnRow}>
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={save}>
            <Text style={styles.btnPrimaryText}>保存</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={test}>
            <Text style={styles.btnText}>测试连接</Text>
          </Pressable>
          {draft.id ? (
            <Pressable style={styles.btn} onPress={() => setDraft(EMPTY_DRAFT)}>
              <Text style={styles.btnText}>取消</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <Text style={styles.foot}>
        密钥存系统安全存储（SecureStore），只发给填写的 baseURL；数据全部在本机 App 私有目录。
      </Text>
    </ScrollView>
  )
}

function Field(props: {
  label: string
  value: string
  onChangeText: (v: string) => void
  placeholder: string
  secureTextEntry?: boolean
  autoCapitalize?: 'none' | 'sentences'
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor="#9aa0aa"
        secureTextEntry={props.secureTextEntry}
        autoCapitalize={props.autoCapitalize ?? 'sentences'}
        autoCorrect={false}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#eef0f4' },
  content: { paddingBottom: 32 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e4ea',
  },
  back: { fontSize: 16, color: '#2f6fed', width: 44 },
  title: { fontSize: 17, fontWeight: '700', color: '#1c1f24' },
  section: { fontSize: 13, fontWeight: '600', color: '#7c828d', marginTop: 18, marginBottom: 6, paddingHorizontal: 16 },
  empty: { color: '#7c828d', fontSize: 13, lineHeight: 19, paddingHorizontal: 16 },
  card: { backgroundColor: '#ffffff', borderRadius: 12, padding: 12, marginHorizontal: 16, marginBottom: 8 },
  cardActive: { borderWidth: 1.5, borderColor: '#2f6fed' },
  cardMain: { flex: 1 },
  cardName: { fontSize: 15, fontWeight: '600', color: '#1c1f24' },
  cardMeta: { fontSize: 12, color: '#7c828d', marginTop: 2 },
  cardBtn: { position: 'absolute', top: 8, paddingHorizontal: 8, paddingVertical: 4 },
  cardBtnText: { fontSize: 13, color: '#2f6fed' },
  presetLabel: { fontSize: 12, color: '#7c828d', marginBottom: 8 },
  presetRow: { gap: 8, paddingBottom: 4 },
  presetChip: {
    borderRadius: 14,
    backgroundColor: '#f2f3f6',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  presetChipText: { fontSize: 13, color: '#1c1f24' },
  field: { marginTop: 10 },
  fieldLabel: { fontSize: 12, color: '#7c828d', marginBottom: 4 },
  fieldInput: {
    borderRadius: 10,
    backgroundColor: '#f2f3f6',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1c1f24',
  },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d6dae2',
    paddingVertical: 10,
    alignItems: 'center',
  },
  btnPrimary: { backgroundColor: '#2f6fed', borderWidth: 0 },
  btnText: { color: '#2f6fed', fontSize: 15 },
  btnPrimaryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  foot: { color: '#9aa0aa', fontSize: 12, lineHeight: 17, marginTop: 14, paddingHorizontal: 16 },
})
