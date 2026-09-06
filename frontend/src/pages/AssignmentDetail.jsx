import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import { STATUS_META, deadlineText, fmtScore, modeLabel, seriesLabel } from "../meta";

function StatusDot({ status }) {
  const meta = STATUS_META[status] || STATUS_META["待批改"];
  return <span className={`state ${meta.state}`} />;
}

export default function AssignmentDetail() {
  const { id } = useParams();
  const [assignment, setAssignment] = useState(null);
  const [students, setStudents] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([apiGet(`/assignments/${id}`), apiGet(`/assignments/${id}/students`)])
      .then(([a, s]) => {
        setAssignment(a);
        setStudents(s);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="page-error">加载失败：{error}</div>;
  if (!assignment) return null;

  const c = assignment.class;

  return (
    <>
      <AppHeader />
      <div className="wrap">
        <Link className="back" to={c ? `/classes/${c.id}` : "/"}>
          ← {c ? `${seriesLabel(c.series)} ${c.name}` : "返回"}
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>
          {assignment.unit_label} {assignment.content}
        </h1>
        <div className="page-meta">
          第 {assignment.lesson_no} 次课
          {assignment.class_time ? ` · ${assignment.class_time}` : ""} · {assignment.status}
          {deadlineText(assignment.class_time) ? ` · ${deadlineText(assignment.class_time)}` : ""}
        </div>
        <div style={{ marginTop: "var(--s4)" }}>
          <Link className="btn primary" to={`/grading/${assignment.id}`}>
            进入批改
          </Link>
        </div>

        <section className="block">
          <div className="sec-title">学生提交状态</div>
          {students.map((s) => {
            const sub = s.submission;
            const status = sub ? sub.status : "待批改";
            return (
              <div className="row" key={s.id}>
                <StatusDot status={status} />
                <span className="row-name">{s.name}</span>
                {status === "缺作业" && <span className="tag-lack">缺项</span>}
                {status === "未交" && <span className="tag-miss">未交</span>}
                <span className="mono">
                  {sub && sub.score !== null ? fmtScore(sub.score) : "—"}
                  {sub && sub.rating ? ` · ${sub.rating_override || sub.rating}` : ""}
                </span>
              </div>
            );
          })}
          {students.length === 0 && <div className="row">暂无学生</div>}
        </section>

        <section className="block">
          <div className="sec-title">题库预览</div>
          {assignment.sections.map((sec) => (
            <div key={sec.section} style={{ marginBottom: "var(--s4)" }}>
              <div className="row" style={{ borderTop: "1px solid var(--line)" }}>
                <span className="row-name">
                  {sec.section}
                  <span>
                    {sec.question_count} 题 ·{" "}
                    {[...new Set(sec.questions.map((q) => modeLabel(q.mode)))].join(" / ")}
                  </span>
                </span>
                <span className="mono">权重 {sec.total_weight}</span>
              </div>
              {sec.questions.map((q) => (
                <div className="row" key={q.id} style={{ padding: "var(--s3) var(--s2)" }}>
                  <span className="mono">{q.seq}.</span>
                  <span className="row-name">
                    {q.stem || q.standard_answer}
                    {q.stem && <span>{q.standard_answer}</span>}
                  </span>
                  <span className="mono">{modeLabel(q.mode)}</span>
                </div>
              ))}
            </div>
          ))}
          {assignment.sections.length === 0 && <div className="row">题库待录入</div>}
        </section>
      </div>
    </>
  );
}
