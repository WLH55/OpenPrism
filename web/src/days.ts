/** 日期小工具（评审 2026-09-29 M4：Today/Plans 两处日差实现舍入语义不同，收敛于此） */

/** 本地时区的今天 YYYY-MM-DD（toISOString 是 UTC，东八区 0-8 点会给"昨天"） */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 日历日差（due - today，单位天）：T00:00:00 本地锚点 + round，DST 偏移 <24h 时不漂移 */
export function daysUntil(due: string, today: string): number {
  return Math.round((new Date(`${due}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000);
}
