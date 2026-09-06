import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import AssignmentForm from "../components/AssignmentForm";
import { classMeta, seriesLabel } from "../meta";

function batchStatus(a) {
  if (a.status === "已完成") return <span className="status-done">已完成</span>;
  if (a.status === "批改中") return <span className="status-doing">批改中</span>;
  return <span className="status-idle">{a.status}</span>;
}

export default function ClassDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [formOpen, setFormOpen] = useState(false);

  const reload = useCallback(() => {
    apiGet(`/classes/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (error) return <div className="page-error">加载失败：{error}</div>;
  if (!data) return null;

  const nextLessonNo = Math.max(0, ...data.assignments.map((a) => a.lesson_no)) + 1;

  return (
    <>
      <AppHeader />
      <div className="wrap">
        <Link className="back" to="/">
          ← 工作台
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>{data.name}</h1>
        <div className="page-meta">
          {seriesLabel(data.series)} · {classMeta(data)} · {data.student_count} 名学生
        </div>

        <section className="block">
          <div className="sec-title sec-title-row">
            批次
            <button className="btn" onClick={() => setFormOpen(true)}>
              + 新建批次
            </button>
          </div>
          {data.assignments.map((a) => (
            <Link className="row" key={a.id} to={`/assignments/${a.id}`}>
              <span className="row-name">
                {a.unit_label} {a.content}
                <span>
                  第 {a.lesson_no} 次课{a.class_time ? ` · ${a.class_time}` : ""}
                </span>
              </span>
              <span className="mono">
                {a.graded_count} / {a.total_students}
              </span>
              {batchStatus(a)}
            </Link>
          ))}
          {data.assignments.length === 0 && <div className="row">暂无批次</div>}
        </section>

        <section className="block">
          <div className="sec-title">学生</div>
          {data.students.map((s) => (
            <div className="row" key={s.id}>
              <span className="row-name">
                {s.name}
                {s.note && <span>{s.note}</span>}
              </span>
            </div>
          ))}
        </section>
      </div>

      <AssignmentForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        classInfo={{ ...data, next_lesson_no: nextLessonNo }}
        onSaved={reload}
      />
    </>
  );
}
