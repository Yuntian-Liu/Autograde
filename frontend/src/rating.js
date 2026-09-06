// 十档等级默认分数线（DEVELOPMENT.md 2.7，待碳碳校准；后端 settings 表持久化同一份默认值）
export const RATING_THRESHOLDS = [
  ["A+", 97],
  ["A", 93],
  ["A-", 90],
  ["B+", 85],
  ["B", 80],
  ["B-", 75],
  ["C+", 70],
  ["C", 65],
  ["C-", 60],
  ["D", 0],
];

export const RATINGS = RATING_THRESHOLDS.map(([rating]) => rating);

export function ratingFor(score) {
  for (const [rating, min] of RATING_THRESHOLDS) {
    if (score >= min) return rating;
  }
  return "D";
}
