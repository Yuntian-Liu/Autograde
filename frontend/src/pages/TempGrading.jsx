import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import AssignmentForm from "../components/AssignmentForm";
import CodeChip from "../components/CodeChip";
import PageSkeleton from "../components/PageSkeleton";
import { IconChevronLeft } from "../components/icons";

function batchStatus(a) {
  if (a.status === "已完成") return <span className="status-done">已完成</span>;
  if (a.status === "批改中") return <span className="status-doing">批改中</span>;
  return <span className="status-idle">{a.status}</span>;
}

export default function TempGrading() {
  const [workspace, setWorkspace] = useState(null);
  const [error, setError] = useState(null);
  const [formOpen, setFormOpen] = useState(false);

  const reload = useCallback(() => {
    apiGet("/temp-workspace").then(setWorkspace).catch((e) => setError(e.message));
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
  if (!workspace)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const assignments = workspace.assignments || [];

  return (
    <div className="page-enter">
      <AppHeader crumbs={[{ label: "工作台", to: "/" }, { label: "临时批改" }]} />
      <div className="wrap">
        <Link className="back" to="/">
          <IconChevronLeft />工作台
        </Link>
        <div className="sec-title-row" style={{ marginTop: "var(--s3)" }}>
          <h1>临时批改</h1>
          <button className="btn" onClick={() => setFormOpen(true)}>
            + 新建批次
          </button>
        </div>

        <section className="block">
          {assignments.map((a) => {
            const studentCount = a.student_count ?? a.total_students ?? 0;
            const assignmentPath = `/assignments/${a.slug || a.id}`;
            return (
              <div className="row temp-batch-row" key={a.id}>
                <Link className="temp-batch-link" to={assignmentPath}>
                  <span className="temp-batch-title">
                    {a.class?.name} · {a.unit_label} {a.content}
                  </span>
                  <span className="temp-batch-sub">
                    {a.note && <span className="temp-batch-note">{a.note}</span>}
                    <CodeChip code={a.code} />
                  </span>
                </Link>
                {studentCount === 0 ? (
                  <Link className="btn primary" to={`${assignmentPath}/quick`}>
                    答案速查
                  </Link>
                ) : (
                  <>
                    <span className="mono">本批 {studentCount} 人</span>
                    {batchStatus(a)}
                  </>
                )}
              </div>
            );
          })}
          {assignments.length === 0 && <div className="row">暂无批次</div>}
        </section>
      </div>

      <AssignmentForm
        temp
        open={formOpen}
        onClose={() => setFormOpen(false)}
        classInfo={workspace}
        onSaved={reload}
      />
    </div>
  );
}
