// 分类稳定取色：分类名哈希 → 原型调色板（动态分类无法预映射，色相分布与原型同族）
const PALETTE = [
  "#2f6b4f", // 墨绿（原型·运动）
  "#b98a3e", // 金（原型·餐饮）
  "#2e7d6b", // 松绿（原型·学习）
  "#64748b", // 蓝灰（原型·睡眠）
  "#8b6f4a", // 棕（原型·阅读）
  "#7d5a8f", // 紫
  "#4f7d9e", // 青蓝
  "#a05f5f", // 砖红
];

export function catColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
