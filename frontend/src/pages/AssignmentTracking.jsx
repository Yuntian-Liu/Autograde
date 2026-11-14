import { useCallback, useEffect, useState } from "react";
import { Link, useBlocker, useParams } from "react-router-dom";
import { App as AntApp } from "antd";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import AssignmentForm from "../components/AssignmentForm";
import CodeChip from "../components/CodeChip";
import PageSkeleton from "../components/PageSkeleton";
import SaveStatus from "../components/SaveStatus";
import TrackingCell from "../components/TrackingCell";
import { IconChevronLeft, IconCopy } from "../components/icons";
import { seriesLabel } from "../meta";
import useTracking from "../utils/useTracking";
import { buildTrackingTsv, copyText } from "../utils/trackingExport";
import { clientLog } from "../utils/clientLog";

export default function AssignmentTracking() {
  const { id } = useParams();
  const { message, modal } = AntApp.useApp();
  const [assignment, setAssignment] = useState(null);
  const [assignmentError, setAssignmentError] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const { tracking, loading, error, saveFailed, reload, toggleCell, pendingCells } = useTracking(id);

  const loadAssignment = useCallback(async () => {
    try {
      const data = await apiGet(`/assignments/${id}`);
      setAssignment(data);
      setAssignmentError(null);
      return data;
    } catch (e) {
      setAssignmentError(e.message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    loadAssignment();
  }, [loadAssignment]);

  const saving = pendingCells.size > 0;
  const blocker = useBlocker(saving);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    modal.confirm({
      title: "登记正在保存",
      content: "保存尚未完成，确定离开？这次操作的结果可能无法确认。",
      okText: "离开",
      cancelText: "继续等待",
      okButtonProps: { danger: true },
      centered: true,
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
  }, [blocker.state]);

  useEffect(() => {
    if (!saving) return;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saving]);

  async function copyTable() {
    if (!tracking || pendingCells.size || copying) return;
    setCopying(true);
    try {
      await copyText(buildTrackingTsv(tracking));
      clientLog.operation("tracking_copy", "success", {
        assignment: id,
        rows: tracking.students.length,
        columns: tracking.items.length,
      });
      message.success("已复制，可粘贴到腾讯文档或 Excel");
    } catch (e) {
      clientLog.operation("tracking_copy", "error", {
        assignment: id,
        rows: tracking.students.length,
        columns: tracking.items.length,
        error: e.message,
      });
      message.error(e.message);
    } finally {
      setCopying(false);
    }
  }

  if (assignmentError) return <div className="page-enter"><div className="page-error">加载失败：{assignmentError}</div></div>;
  if (!assignment) return <div className="page-enter"><PageSkeleton /></div>;

  const c = assignment.class;
  const isTemp = Boolean(c?.is_temp);
  const title = `${isTemp && c?.name ? `${c.name} · ` : ""}${assignment.unit_label} ${assignment.content}`.trim();

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          ...(isTemp
            ? [{ label: "临时批改", to: "/temp" }]
            : c
              ? [{ label: `${seriesLabel(c.series)} ${c.name}`, to: `/classes/${c.id}` }]
              : []),
          { label: title, to: `/assignments/${assignment.slug || assignment.id}` },
          { label: "提交登记" },
        ]}
      />
      <div className="wrap wrap-wide">
        <Link className="back" to={`/assignments/${assignment.slug || assignment.id}`}>
          <IconChevronLeft />返回批次
        </Link>
        <h1 className="analysis-title">{title} · 提交登记</h1>
        <div className="page-meta">
          {!isTemp && `第 ${assignment.lesson_no} 次课 · `}
          <CodeChip code={assignment.code} />
        </div>
        <div className="btn-row tracking-actions">
          <button className="btn primary" disabled={!tracking || pendingCells.size > 0 || copying} onClick={copyTable}>
            <IconCopy />{copying ? "复制中…" : "复制表格"}
          </button>
          <button className="btn" onClick={() => setEditOpen(true)}>编辑项目</button>
          <SaveStatus dirty={false} saving={saving} failed={saveFailed} />
        </div>

        <section className="block">
          {loading ? (
            <PageSkeleton />
          ) : error && !tracking ? (
            <div className="page-error">登记加载失败：{error}</div>
          ) : (
            <div className="tracking-scroll">
              <table className="tracking-table">
                <thead>
                  <tr>
                    <th className="tracking-no">No.</th>
                    <th className="tracking-name">Name</th>
                    {tracking?.items.map((item) => (
                      <th className="tracking-item-head" key={item.id}>
                        <span>{item.name}</span>
                        <span className="tracking-item-count">
                          {item.submitted_count} / {tracking.total_students}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tracking?.students.map((student, index) => (
                    <tr key={student.id}>
                      <td className="tracking-no">{index + 1}</td>
                      <td className="tracking-name" title={student.name}>{student.name}</td>
                      {tracking.items.map((item) => (
                        <td key={item.id}>
                          <TrackingCell
                            item={item}
                            cell={student.cells?.[String(item.id)]}
                            saving={pendingCells.has(`${student.id}:${item.id}`)}
                            onToggle={() => toggleCell(student.id, item)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {tracking?.students.length === 0 && (
                    <tr><td colSpan={2 + tracking.items.length}>暂无学生</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <AssignmentForm
        open={editOpen}
        onClose={() => setEditOpen(false)}
        classInfo={c}
        assignment={assignment}
        temp={isTemp}
        onSaved={async () => {
          await Promise.all([loadAssignment(), reload()]);
        }}
      />
    </div>
  );
}
