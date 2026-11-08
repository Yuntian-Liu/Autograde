// 排行榜排名口径（纯函数，后端只供成绩矩阵，口径全在这里算）：
// - 进平均分：status ∈ {已批改, 缺作业} 且 score ≠ null
// - 提交率分子（已交）：status ∈ {已批改, 缺作业}；未交/待批改/无记录都算缺交
// - 实时排名：范围 = 未开始以外的批次（已开始就算），得分 = 平均分 × 提交率（分母 = 范围批次数）
// - 历次排名：范围 = 已完成批次的前 upto 个；weighted=true 同实时口径（分母=upto），
//   weighted=false（纯分数）= 平均分（交几次除几次）
// - 无有效成绩：平均分 null、得分 0、排最后（按名字稳定排序）
// - 同分不设并列：比「最后一份计入成绩的批改时间」（先批完优先，ACM 式），再平按名字；名次永远一人

const SCORED = new Set(["已批改", "缺作业"]);

// 批次状态推导：pending == total_students → 未开始；pending == 0 → 已完成；之间 → 批改中
export function batchStatus(b) {
  if (b.total_students === 0 || b.pending === b.total_students) return "未开始";
  if (b.pending === 0) return "已完成";
  return "批改中";
}

export function computeLeaderboard(batches, students, { live = true, upto = null, weighted = true, view = "score" } = {}) {
  let range;
  let useWeighted = weighted;
  if (live) {
    range = batches.filter((b) => batchStatus(b) !== "未开始");
    useWeighted = true; // 实时永远含提交率，忽略 upto/weighted
  } else {
    const done = batches.filter((b) => batchStatus(b) === "已完成");
    range = upto === null || upto === undefined ? done : done.slice(0, upto);
  }
  const total = range.length;

  const rows = students.map((s) => {
    const cells = s.cells || {};
    let sum = 0;
    let gpaSum = 0;
    let scored = 0;
    let gpaCount = 0;
    let submitted = 0;
    let lastGradedAt = null;
    for (const b of range) {
      const cell = cells[b.assignment_id];
      if (!cell) continue;
      if (SCORED.has(cell.status)) {
        submitted += 1;
        if (cell.score !== null && cell.score !== undefined) {
          sum += Number(cell.score);
          scored += 1;
          if (cell.gpa !== null && cell.gpa !== undefined) {
            gpaSum += Number(cell.gpa);
            gpaCount += 1;
          }
          if (cell.graded_at && (!lastGradedAt || cell.graded_at > lastGradedAt)) {
            lastGradedAt = cell.graded_at;
          }
        }
      }
    }
    const avg = scored ? sum / scored : null;
    const avgGpa = gpaCount ? gpaSum / gpaCount : null;
    const score = avg === null ? 0 : useWeighted && total > 0 ? (avg * submitted) / total : avg;
    const gpaScore = avgGpa === null ? 0 : useWeighted && total > 0 ? (avgGpa * submitted) / total : avgGpa;
    return { student_id: s.student_id, name: s.name, rank: 0, score, avg, avg_gpa: avgGpa, gpa_score: gpaScore, submitted, total, lastGradedAt };
  });

  const valueOf = (row) => view === "gpa" ? row.gpa_score : row.score;
  const avgOf = (row) => view === "gpa" ? row.avg_gpa : row.avg;
  rows.sort(
    (a, b) =>
      valueOf(b) - valueOf(a) ||
      (avgOf(a) === null ? 1 : 0) - (avgOf(b) === null ? 1 : 0) ||
      (a.lastGradedAt ? Date.parse(a.lastGradedAt) : Infinity) -
        (b.lastGradedAt ? Date.parse(b.lastGradedAt) : Infinity) ||
      a.name.localeCompare(b.name)
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return rows;
}
