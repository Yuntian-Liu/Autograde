// 能力报告六维定义（与 backend/ai.py _ABILITY_DIMENSIONS 一一对应，顺序固定）
export const ABILITY_DIMS = [
  { key: "vocabulary", label: "词汇掌握" },
  { key: "grammar", label: "语法运用" },
  { key: "spelling", label: "拼写与书写" },
  { key: "reading", label: "阅读理解" },
  { key: "sentence", label: "句型与表达" },
  { key: "habit", label: "学习习惯" },
];

export const DIM_LABEL = Object.fromEntries(ABILITY_DIMS.map((d) => [d.key, d.label]));

export function rangeLabel(r) {
  if (!r.range_start && !r.range_end) return "全部历史";
  return `${r.range_start || "最早"} ~ ${r.range_end || "至今"}`;
}
