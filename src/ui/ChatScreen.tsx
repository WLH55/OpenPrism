/**
 * 对话屏：流式对话 + 工具调用展示；会话日志落 sessions/main.jsonl（回看材料）。
 * 事件由工具直接写事件日志——本屏只负责对话体验。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { ListRenderItem } from 'react-native'
import { randomUUID } from 'expo-crypto'
import { sharedEventStore as store } from '../store/store'
import { appendMessage, loadSession } from '../store/sessions'
import { resolveCurrentProvider } from '../store/providers'
import type { ChatMessage } from '../llm/client'
import { LlmError, friendlyLlmMessage } from '../llm/errors'
import { runAgentLoop } from '../agent/loop'

const SESSION_ID = 'main'

interface DisplayItem {
  key: string
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  status?: 'streaming' | 'pending' | 'done'
}

function fromStored(): DisplayItem[] {
  const items: DisplayItem[] = []
  let n = 0
  for (const m of loadSession(SESSION_ID)) {
    n += 1
    if (m.role === 'user') {
      items.push({ key: `h${n}`, role: 'user', text: m.content ?? '' })
    } else if (m.role === 'assistant') {
      if (m.content) items.push({ key: `h${n}`, role: 'assistant', text: m.content })
    } else {
      items.push({ key: `h${n}`, role: 'tool', text: `🔧 ${summarizeTool(m.content)}` })
    }
  }
  return items
}

function summarizeTool(content?: string): string {
  if (!content) return '工具调用'
  return content.split('\n')[0].slice(0, 80)
}

export function ChatScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [items, setItems] = useState<DisplayItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<FlatList<DisplayItem> | null>(null)
  const counter = useRef(0)
  const historyRef = useRef<ChatMessage[]>([])
  const openStreamKey = useRef<string | null>(null)
  const pendingToolKeys = useRef<string[]>([])

  useEffect(() => {
    const stored = fromStored()
    setItems(stored)
    // 由会话日志恢复内存历史（system 不落会话日志，每次请求动态生成）
    const history: ChatMessage[] = []
    for (const m of loadSession(SESSION_ID)) {
      if (m.role === 'user') history.push({ role: 'user', content: m.content })
      else if (m.role === 'assistant') {
        history.push({ role: 'assistant', content: m.content, toolCalls: m.toolCalls })
      } else {
        history.push({ role: 'tool', toolCallId: m.toolCallId, content: m.content })
      }
    }
    historyRef.current = history
  }, [])

  const nextKey = useCallback(() => {
    counter.current += 1
    return `m${counter.current}`
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setNotice(null)
    setItems((prev) => [...prev, { key: nextKey(), role: 'user', text }])
    setBusy(true)

    const provider = await resolveCurrentProvider()
    if (!provider) {
      setNotice('还没配置模型（API Key）——点右上角 ⚙️ 去设置')
      setBusy(false)
      return
    }

    const closeStream = (finalText?: string): void => {
      const key = openStreamKey.current
      openStreamKey.current = null
      if (!key) return
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.key === key)
        if (idx < 0) return prev
        if (!finalText) {
          const copy = [...prev]
          copy.splice(idx, 1)
          return copy
        }
        const copy = [...prev]
        copy[idx] = { ...copy[idx], text: finalText, status: 'done' }
        return copy
      })
    }

    try {
      const result = await runAgentLoop(
        {
          provider,
          store,
          sessionId: SESSION_ID,
          now: () => Date.now(),
          newId: randomUUID,
          signal: undefined,
        },
        historyRef.current,
        text,
        (event) => {
          if (event.type === 'text-delta') {
            const key = openStreamKey.current ?? nextKey()
            openStreamKey.current = key
            setItems((prev) => {
              const idx = prev.findIndex((i) => i.key === key)
              if (idx < 0) return [...prev, { key, role: 'assistant', text: event.text, status: 'streaming' }]
              const copy = [...prev]
              copy[idx] = { ...copy[idx], text: copy[idx].text + event.text }
              return copy
            })
          } else if (event.type === 'assistant') {
            closeStream(event.message.content)
          } else if (event.type === 'tool-call') {
            closeStream(undefined)
            const key = nextKey()
            pendingToolKeys.current.push(key)
            setItems((prev) => [...prev, { key, role: 'tool', text: `🔧 ${event.name} …`, status: 'pending' }])
          } else {
            const key = pendingToolKeys.current.shift()
            if (key) {
              setItems((prev) => {
                const idx = prev.findIndex((i) => i.key === key)
                if (idx < 0) return prev
                const copy = [...prev]
                copy[idx] = { ...copy[idx], text: `🔧 ${summarizeTool(event.result)}`, status: 'done' }
                return copy
              })
            }
          }
        },
      )
      historyRef.current = result.messages
      // 会话日志追加（回看材料；事件的正典在事件日志）
      for (const m of result.newMessages) {
        appendMessage(
          SESSION_ID,
          {
            role: m.role === 'tool' ? 'tool' : m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
            toolCalls: m.toolCalls,
            toolCallId: m.toolCallId,
          },
          Date.now(),
        )
      }
    } catch (e) {
      closeStream(undefined)
      const message = e instanceof LlmError ? friendlyLlmMessage(e) : e instanceof Error ? e.message : String(e)
      setItems((prev) => [...prev, { key: nextKey(), role: 'error', text: message }])
    } finally {
      setBusy(false)
    }
  }, [input, busy, nextKey])

  const renderItem: ListRenderItem<DisplayItem> = useCallback(({ item }) => {
    if (item.role === 'tool') {
      return (
        <View style={styles.toolWrap}>
          <Text style={styles.toolText}>{item.text}</Text>
          {item.status === 'pending' ? <ActivityIndicator size="small" color="#9aa0aa" /> : null}
        </View>
      )
    }
    if (item.role === 'error') {
      return (
        <View style={[styles.bubble, styles.errorBubble]}>
          <Text style={styles.errorText}>⚠️ {item.text}</Text>
        </View>
      )
    }
    const mine = item.role === 'user'
    return (
      <View style={[styles.bubble, mine ? styles.userBubble : styles.assistantBubble]}>
        <Text style={mine ? styles.userText : styles.assistantText}>{item.text}</Text>
        {item.status === 'streaming' ? <Text style={styles.cursor}>▍</Text> : null}
      </View>
    )
  }, [])

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.title}>OpenPrism</Text>
        <Pressable hitSlop={12} onPress={onOpenSettings}>
          <Text style={styles.gear}>⚙️</Text>
        </Pressable>
      </View>
      {notice ? (
        <Pressable style={styles.notice} onPress={onOpenSettings}>
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      ) : null}
      <FlatList
        ref={listRef}
        data={items}
        renderItem={renderItem}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />
      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="花了 35 吃午饭 / 心情 7 分 / 背了 40 分钟单词…"
          placeholderTextColor="#9aa0aa"
          multiline
          editable={!busy}
        />
        <Pressable style={[styles.send, busy && styles.sendDisabled]} onPress={send} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendText}>发送</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#eef0f4' },
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
  title: { fontSize: 17, fontWeight: '700', color: '#1c1f24' },
  gear: { fontSize: 20 },
  notice: { backgroundColor: '#fff7e0', paddingHorizontal: 16, paddingVertical: 8 },
  noticeText: { color: '#8a6d1d', fontSize: 13 },
  listContent: { paddingHorizontal: 12, paddingVertical: 12 },
  bubble: {
    maxWidth: '82%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#2f6fed' },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: '#ffffff' },
  userText: { color: '#ffffff', fontSize: 15, lineHeight: 22 },
  assistantText: { color: '#1c1f24', fontSize: 15, lineHeight: 22 },
  cursor: { color: '#2f6fed', fontSize: 13 },
  toolWrap: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, maxWidth: '82%' },
  toolText: { color: '#7c828d', fontSize: 12, lineHeight: 16, flexShrink: 1 },
  errorBubble: { alignSelf: 'flex-start', backgroundColor: '#fdeceb' },
  errorText: { color: '#b3261e', fontSize: 13, lineHeight: 18 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: '#ffffff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e4ea',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 20,
    backgroundColor: '#f2f3f6',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1c1f24',
  },
  send: {
    borderRadius: 20,
    backgroundColor: '#2f6fed',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendDisabled: { backgroundColor: '#b9c6e4' },
  sendText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
})
