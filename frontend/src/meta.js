// 展示层元数据：状态灯 / 题目模式 / 班级命名

export const STATUS_META = {
  已批改: { state: "done", label: "已批改" },
  待批改: { state: "todo", label: "待批改" },
  缺作业: { state: "missing", label: "缺项" },
  未交: { state: "absent", label: "未交" },
};

export const MODE_LABELS = {
  verbatim: "直出",
  ai_expand: "AI 扩写",
  manual: "人工填充",
};

export function modeLabel(mode) {
  return MODE_LABELS[mode] || mode;
}

const SERIES_LABEL = { WW: "厚少", NG: "厚中" };
const SERIES_NAME = { WW: "Wonderful World", NG: "NG" };
const CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const TERM_META = { A: { label: "上册", range: "U1-6" }, B: { label: "下册", range: "U7-12" } };

export function seriesLabel(series) {
  return SERIES_LABEL[series] || series;
}

export function classMeta(c) {
  const term = TERM_META[c.term] || { label: c.term, range: "" };
  const levelCn = CN_NUM[c.level] ?? c.level;
  return `${SERIES_NAME[c.series] || c.series} ${levelCn}级${term.label}（${term.range}）· ${c.schedule}`;
}

// class_time 形如 "2026-09-12 14:00"，返回距今天数；解析失败返回 null
export function daysUntil(classTime) {
  if (!classTime) return null;
  const d = new Date(classTime.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

export function deadlineText(classTime) {
  const days = daysUntil(classTime);
  if (days === null || days < 0) return null;
  if (days === 0) return "今天上课";
  return `距上课 ${days} 天`;
}

export function fmtScore(score) {
  return score === null || score === undefined ? "—" : Number(score).toFixed(2);
}

// 分数颜色策略（仅视觉提示无语义）：≥75 绿 / [60,75) 橙 / <60 红
export function scoreTone(score) {
  if (score === null || score === undefined) return "";
  const n = Number(score);
  if (n >= 75) return "tone-good";
  if (n >= 60) return "tone-mid";
  return "tone-bad";
}

// 等级 F 红色展示（仅视觉）
export function ratingTone(rating) {
  return rating === "F" ? "tone-bad" : "";
}

// 问候语时段（对应 phrases 表「问候语·X」category，参照旧版 build_greeting 划分）
export function greetingSlot(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "早上";
  if (h >= 11 && h < 13) return "中午";
  if (h >= 13 && h < 18) return "下午";
  return "晚上";
}

// Issue 话术占位符：{preview_unit_full}→U7B，{preview_unit}→U7；无预习批次回落本批次单元
export function fillIssuePlaceholders(text, assignment, classInfo) {
  const full =
    assignment.has_preview && assignment.preview_unit_no
      ? `U${assignment.preview_unit_no}${assignment.preview_half}`
      : `U${assignment.unit_no}${classInfo?.term || ""}`;
  const unit = full.replace(/[AB]$/, "");
  return text.replaceAll("{preview_unit_full}", full).replaceAll("{preview_unit}", unit);
}
