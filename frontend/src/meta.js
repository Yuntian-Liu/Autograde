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
