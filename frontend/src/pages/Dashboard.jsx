import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import ClassForm from "../components/ClassForm";
import PageSkeleton from "../components/PageSkeleton";
import { classMeta, deadlineText, scoreTone, seriesLabel } from "../meta";

function batchStatus(a) {
  if (a.status === "已完成") return <span className="status-done">已完成</span>;
  if (a.status === "批改中") return <span className="status-doing">批改中</span>;
  return <span className="status-idle">{a.status}</span>;
}

function todoText(a) {
  if (a.question_count === 0) return "题库待录入";
  if (a.pending_count > 0) return `还有 ${a.pending_count} 人未批改`;
  if (a.absent_count > 0) return `${a.absent_count} 人未交`;
  return "待开始批改";
}

export default function Dashboard() {
  const [classes, setClasses] = useState(null); // null = 加载中
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState(null);
  const [classFormOpen, setClassFormOpen] = useState(false);

  const reload = useCallback(() => {
    Promise.all([apiGet("/classes"), apiGet("/assignments?limit=6")])
      .then(([c, a]) => {
        setClasses(c);
        setRecent(a);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (classes === null)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const todos = recent.filter((a) => a.status !== "已完成");

  return (
    <div className="page-enter">
      <AppHeader showDate />
      <div className="wrap">
        <h1>工作台</h1>

        {todos.length > 0 && (
          <section className="block">
            <div className="sec-title">待办</div>
            {todos.map((a) => (
              <Link
                className="row"
                key={a.id}
                to={a.question_count > 0 ? `/grading/${a.id}` : `/assignments/${a.id}`}
              >
                <span className="todo-main">
                  <b>
                    {a.class ? `${seriesLabel(a.class.series)} ${a.class.name}` : ""} · {a.unit_label}
                  </b>
                  　{todoText(a)}
                </span>
                {deadlineText(a.class_time) && (
                  <span className="todo-when">{deadlineText(a.class_time)}</span>
                )}
              </Link>
            ))}
          </section>
        )}

        <section className="block">
          <div className="sec-title sec-title-row">
            班级
            <button className="btn" onClick={() => setClassFormOpen(true)}>
              + 新建班级
            </button>
          </div>
          {classes.length === 0 && (
            <div className="empty-state">
              <p>还没有班级</p>
              <button className="btn primary" onClick={() => setClassFormOpen(true)}>
                新建第一个班级
              </button>
            </div>
          )}
          {classes.map((c) => (
            <Link className="row" key={c.id} to={`/classes/${c.id}`}>
              <span>
                <div className="class-name">
                  {c.name}
                  <span>{seriesLabel(c.series)}</span>
                </div>
                <div className="class-meta">
                  {classMeta(c)} · {c.student_count} 名学生
                </div>
              </span>
              <span className="class-nums">
                <span>
                  <div className={c.pending_count > 0 ? "num accent" : "num"}>{c.pending_count}</div>
                  <div className="num-label">待批改</div>
                </span>
                <span>
                  <div className={`num ${scoreTone(c.last_avg_score)}`}>
                    {c.last_avg_score === null ? "—" : Number(c.last_avg_score).toFixed(2)}
                  </div>
                  <div className="num-label">上批平均分</div>
                </span>
              </span>
            </Link>
          ))}
        </section>

        <section className="block">
          <div className="sec-title">最近批次</div>
          {recent.map((a) => (
            <Link className="row" key={a.id} to={`/assignments/${a.id}`}>
              <span className="row-name">
                {a.unit_label} {a.content}
                <span>
                  {a.class ? `${seriesLabel(a.class.series)} ${a.class.name}` : ""} · 第 {a.lesson_no} 次课
                </span>
              </span>
              <span className="mono">
                {a.graded_count} / {a.total_students}
              </span>
              {batchStatus(a)}
            </Link>
          ))}
        </section>
      </div>

      <ClassForm
        open={classFormOpen}
        onClose={() => setClassFormOpen(false)}
        onSaved={reload}
      />
    </div>
  );
}
