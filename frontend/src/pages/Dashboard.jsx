import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import ClassForm from "../components/ClassForm";
import PageSkeleton from "../components/PageSkeleton";
import { classMeta, daysUntil, scoreTone, seriesLabel } from "../meta";

function batchStatus(a) {
  if (a.status === "已完成") return <span className="status-done">已完成</span>;
  if (a.status === "批改中") return <span className="status-doing">批改中</span>;
  return <span className="status-idle">{a.status}</span>;
}

// 看板行内待办摘要：题库/待批/未交 并列呈现（不再三选一）
function boardText(a) {
  const parts = [];
  if (a.question_count === 0) parts.push("题库待录入");
  if (a.pending_count > 0) parts.push(`待批 ${a.pending_count} 人`);
  if (a.absent_count > 0) parts.push(`未交 ${a.absent_count} 人`);
  return parts.length ? parts.join(" · ") : "待开始批改";
}

// 天数胶囊：已过期/≤1 天 红，≤3 天 橙，其余灰；无排课灰「未排课」
function boardWhen(a) {
  const days = daysUntil(a.class_time);
  if (days === null) return { text: "未排课", cls: "todo" };
  if (days < 0) return { text: `已上课 ${-days} 天`, cls: "miss" };
  if (days === 0) return { text: "今天上课", cls: "miss" };
  if (days === 1) return { text: "明天上课", cls: "miss" };
  if (days <= 3) return { text: `距上课 ${days} 天`, cls: "lack" };
  return { text: `距上课 ${days} 天`, cls: "todo" };
}

export default function Dashboard() {
  const [classes, setClasses] = useState(null); // null = 加载中
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState(null);
  const [classFormOpen, setClassFormOpen] = useState(false);

  const reload = useCallback(() => {
    // limit 放宽到 20：看板要覆盖远期已排课的未完成批次；「最近批次」前端截前 6 个
    Promise.all([apiGet("/classes"), apiGet("/assignments?limit=20")])
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

  // 批改看板：未完成批次按距上课天数升序（过期的最前，未排课垫底，保持原时间序）
  const todos = recent
    .filter((a) => a.status !== "已完成")
    .map((a, i) => ({ a, i, d: daysUntil(a.class_time) }))
    .sort((x, y) => (x.d ?? 9999) - (y.d ?? 9999) || x.i - y.i)
    .map((t) => t.a);

  return (
    <div className="page-enter">
      <AppHeader showDate />
      <div className="wrap">
        <h1>工作台</h1>

        {todos.length > 0 && (
          <section className="block">
            <div className="sec-title">批改看板</div>
            {todos.map((a) => {
              const when = boardWhen(a);
              return (
                <Link
                  className="row"
                  key={a.id}
                  to={`/assignments/${a.slug || a.id}`}
                >
                  <span className="todo-main">
                    <b>
                      {a.class ? `${seriesLabel(a.class.series)} ${a.class.name}` : ""} · {a.unit_label}
                    </b>
                    　{boardText(a)}
                  </span>
                  <span className={`tag-pill ${when.cls}`}>{when.text}</span>
                </Link>
              );
            })}
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
          <Link className="row" to="/notes">
            <span className="row-name">
              笔记库
              <span>批改反馈与图文笔记</span>
            </span>
          </Link>
        </section>

        <section className="block">
          <div className="sec-title">最近批次</div>
          {recent.slice(0, 6).map((a) => (
            <Link className="row" key={a.id} to={`/assignments/${a.slug || a.id}`}>
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
