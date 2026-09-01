/**
 * App 入口：底部三 Tab（对话 / 面板 / 设置）。
 * 批次 1 双屏 + 批次 2 面板成品；条件渲染切屏——各屏挂载时自行从磁盘恢复状态。
 */

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { ChatScreen } from './src/ui/ChatScreen'
import { PanelScreen } from './src/ui/PanelScreen'
import { SettingsScreen } from './src/ui/SettingsScreen'

type Screen = 'chat' | 'panel' | 'settings'

const TABS: Array<{ key: Screen; icon: string; label: string }> = [
  { key: 'chat', icon: '💬', label: '对话' },
  { key: 'panel', icon: '📊', label: '面板' },
  { key: 'settings', icon: '⚙️', label: '设置' },
]

export default function App() {
  const [screen, setScreen] = useState<Screen>('chat')
  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {screen === 'chat' ? (
          <ChatScreen onOpenSettings={() => setScreen('settings')} />
        ) : screen === 'panel' ? (
          <PanelScreen />
        ) : (
          <SettingsScreen onBack={() => setScreen('chat')} />
        )}
      </View>
      <View style={styles.tabbar}>
        {TABS.map((tab) => (
          <Pressable key={tab.key} style={styles.tab} onPress={() => setScreen(tab.key)} hitSlop={6}>
            <Text style={styles.tabIcon}>{tab.icon}</Text>
            <Text style={[styles.tabLabel, screen === tab.key && styles.tabLabelOn]}>{tab.label}</Text>
          </Pressable>
        ))}
      </View>
      <StatusBar style="dark" />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#eef0f4' },
  body: { flex: 1 },
  tabbar: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e4ea',
    paddingBottom: 4,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 6, gap: 1 },
  tabIcon: { fontSize: 20 },
  tabLabel: { fontSize: 11, color: '#9aa0aa' },
  tabLabelOn: { color: '#2f6fed', fontWeight: '600' },
})
