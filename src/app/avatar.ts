// 形象字段（头像图片 / emoji / 色盘）校验：用户资料与伙伴身份共用同一套规则，
// 头像一律为 data:image/* base64 data URL（本地存储，不外链）。

export const AVATAR_MAX = 200_000;
const AVATAR_RE = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMOJI_MAX = 16;

export interface FaceFields {
  emoji?: string;
  color?: string;
  avatar?: string;
}

/** 形象字段校验（undefined 字段不动）；非法即抛错 */
export function validateFace(patch: FaceFields): void {
  if (patch.emoji !== undefined && String(patch.emoji).length > EMOJI_MAX) throw new Error(`emoji 超过 ${EMOJI_MAX} 字上限`);
  if (patch.avatar !== undefined && patch.avatar !== "" && !AVATAR_RE.test(patch.avatar)) throw new Error("avatar 必须是 data:image/* base64");
  if (patch.avatar !== undefined && patch.avatar.length > AVATAR_MAX) throw new Error(`avatar 超过 ${AVATAR_MAX} 字符上限`);
  if (patch.color !== undefined && patch.color !== "" && !COLOR_RE.test(patch.color)) throw new Error("color 需要 #rrggbb");
}
