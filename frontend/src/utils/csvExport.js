import { fmtTime } from "../meta";
import { gpaForRating } from "../gpa";

const EXPORT_KINDS = {
  ranking: { label: "学生成绩", filename: "学生成绩" },
  questions: { label: "题目统计", filename: "题目统计" },
};

function cell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function filePart(value) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, "_").trim();
}

export function createAssignmentCsv(data, kind) {
  const config = EXPORT_KINDS[kind];
  if (!config) throw new Error("未知导出类型");
  const assignment = data.assignment;
  let headers;
  let rows;
  if (kind === "ranking") {
    headers = ["排名", "SID", "姓名", "状态", "分数", "最终等级", "GPA", "批改时间"];
    const ranks = new Map((data.ranking || []).map((row) => [row.student_id, row.rank]));
    rows = (data.students || data.ranking || []).map((row) => [
      ranks.get(row.student_id) ?? row.rank ?? "",
      row.code || "",
      row.name,
      row.status,
      row.status === "待批改" ? "" : Number(row.rank_score ?? row.score ?? 0).toFixed(2),
      row.rating || "",
      row.status === "待批改" || row.gpa === null || row.gpa === undefined
        ? ""
        : Number(row.gpa ?? gpaForRating(row.rating)).toFixed(2),
      row.graded_at ? fmtTime(row.graded_at) : "",
    ]);
  } else {
    headers = ["板块", "题号", "题干", "满分", "正确率", "答错人数", "答错学生"];
    rows = (data.sections || []).flatMap((section) =>
      (section.questions || []).map((question) => [
        section.section,
        question.seq,
        question.stem || "",
        question.score_weight,
        question.correct_rate === null || question.correct_rate === undefined
          ? ""
          : `${Number(question.correct_rate).toFixed(2)}%`,
        (question.wrong_students || []).length,
        (question.wrong_students || []).map((student) => student.name).join("、"),
      ])
    );
  }
  const filename = `${filePart(assignment.class?.name)} ${filePart(assignment.unit_label)} ${config.filename}.csv`.trim();
  const content = `\uFEFF${[headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}`;
  return { content, filename, count: rows.length, label: config.label };
}

export function downloadAssignmentCsv(data, kind) {
  const result = createAssignmentCsv(data, kind);
  const blob = new Blob([result.content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
  return result;
}
