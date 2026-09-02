// 零依赖小工具。

// FNV-1a 32 位哈希：request/header 指纹与工具表指纹用（设计 §8）。
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// 默认 sleep：全局 setTimeout 存在于一切 JS 宿主；测试注入假实现换确定性。
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
