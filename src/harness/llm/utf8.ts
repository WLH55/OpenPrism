// 极简增量 UTF-8 解码器：跨 chunk 的多字节中文不截断（设计 §4.3）。
// 自己实现而非依赖宿主 TextDecoder，保持核心零平台依赖（Hermes 历史上缺 TextDecoder）。

export class IncrementalUtf8Decoder {
  private pending: number[] = [];

  /** 解码一段字节；未完结的多字节序列留在内部状态里等下一段 */
  decode(bytes: Uint8Array): string {
    let out = "";
    for (const byte of bytes) {
      if (byte < 0x80) {
        out += this.flushReplacement() + String.fromCharCode(byte);
        continue;
      }
      if (byte < 0xc0) {
        // 续字节：无挂起序列则属悬空续字节，按替换符处理
        this.pending.push(byte);
      } else {
        // 新的首字节：挂起序列若未完结，按替换符结算
        out += this.flushReplacement();
        this.pending = [byte];
      }
      if (this.pending.length > 0) {
        const codePoint = tryDecode(this.pending);
        if (typeof codePoint === "number") {
          out += String.fromCodePoint(codePoint);
          this.pending = [];
        } else if (codePoint === -1 || this.pending.length >= 4) {
          out += this.flushReplacement();
        }
      }
    }
    return out;
  }

  /** 流结束时调用：未完结序列按替换符结算 */
  flush(): string {
    return this.flushReplacement();
  }

  private flushReplacement(): string {
    if (this.pending.length === 0) return "";
    this.pending = [];
    return "\uFFFD";
  }
}

/** 完整则返回码点；不完整返回 null；非法返回 -1 */
function tryDecode(bytes: number[]): number | null | -1 {
  const lead = bytes[0]!;
  let length: number;
  let minValue: number;
  if (lead >= 0xc2 && lead <= 0xdf) {
    length = 2;
    minValue = 0x80;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    length = 3;
    minValue = 0x800;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    length = 4;
    minValue = 0x10000;
  } else {
    return -1; // 过长编码 c0/c1 或非法首字节
  }
  if (bytes.length < length) return null;
  let codePoint = lead & (0x7f >> length);
  for (let i = 1; i < length; i++) {
    const byte = bytes[i]!;
    if (byte < 0x80 || byte > 0xbf) return -1;
    codePoint = (codePoint << 6) | (byte & 0x3f);
  }
  if (codePoint < minValue || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return -1;
  }
  return codePoint;
}
