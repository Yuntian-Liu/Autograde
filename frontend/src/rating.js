// 十二档等级分数线（真实教学校准值，左闭右开、A+ 双闭；后端 settings 表持久化同一份默认值）
export const RATING_THRESHOLDS = [
  ["A+", 95],
  ["A", 90],
  ["A-", 85],
  ["B+", 82],
  ["B", 78],
  ["B-", 75],
  ["C+", 72],
  ["C", 68],
  ["C-", 65],
  ["D", 61],
  ["E", 60],
  ["F", 0],
];

export const RATINGS = RATING_THRESHOLDS.map(([rating]) => rating);

// thresholds 可传当前生效分数线（后端 settings 可覆盖）；不传用默认校准值
export function ratingFor(score, thresholds = RATING_THRESHOLDS) {
  for (const [rating, min] of thresholds) {
    if (score >= min) return rating;
  }
  return "F";
}
