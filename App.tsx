/**
 * App 入口：批次 1 双屏（对话 / 厂商设置），批次 2 加面板成品。
 */

import { useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { ChatScreen } from './src/ui/ChatScreen'
import { SettingsScreen } from './src/ui/SettingsScreen'

export default function App() {
  const [screen, setScreen] = useState<'chat' | 'settings'>('chat')
  return (
    <>
      {screen === 'chat' ? (
        <ChatScreen onOpenSettings={() => setScreen('settings')} />
      ) : (
        <SettingsScreen onBack={() => setScreen('chat')} />
      )}
      <StatusBar style="dark" />
    </>
  )
}
