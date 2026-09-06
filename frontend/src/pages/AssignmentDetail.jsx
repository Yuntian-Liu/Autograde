import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { App as AntApp, Input, Modal, Popconfirm } from "antd";
import { apiDelete, apiGet, apiPatch } from "../api";
import AppHeader from "../components/AppHeader";
import AssignmentForm from "../components/AssignmentForm";
import QuestionCard from "../components/QuestionCard";
import QuestionEditModal from "../components/QuestionEdit";
import { AiEntryModal, ManualEntryModal } from "../components/QuestionEntry";
import PageSkeleton from "../components/PageSkeleton";
import { STATUS_META, deadlineText, fmtScore, modeLabel, ratingTone, scoreTone, seriesLabel } from "../meta";

function StatusDot({ status }) {
  const meta = STATUS_META[status] || STATUS_META["待批改"];
  return <span className={`state ${meta.state}`} />;
}

export default function AssignmentDetail() {
  const { id } = useParams();
  const { message } = AntApp.useApp();
  const [assignment, setAssignment] = useState(null);
  const [students, setStudents] = useState([]);
  const [error, setError] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [addSection, setAddSection] = useState(null); // 板块级「加题」预填板块名
  const [activeSection, setActiveSection] = useState(null); // 题库目录选中板块
  const [renameFrom, setRenameFrom] = useState(null); // 重命名板块：原名（null=关闭）
  const [renameTo, setRenameTo] = useState("");
  const [renaming, setRenaming] = useState(false);

  const reload = useCallback(() => {
    Promise.all([apiGet(`/assignments/${id}`), apiGet(`/assignments/${id}/students`)])
      .then(([a, s]) => {
        setAssignment(a);
        setStudents(s);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function removeQuestion(qid) {
    try {
      await apiDelete(`/questions/${qid}`);
      message.success("题目已删除");
      reload();
    } catch (e) {
      message.error(e.message);
    }
  }

  async function renameSection() {
    const to = renameTo.trim();
    if (!to) return message.error("板块名不能为空");
    setRenaming(true);
    try {
      await apiPatch(`/assignments/${id}/sections`, { from: renameFrom, to });
      message.success(`已重命名为「${to}」`);
      setActiveSection(to);
      setRenameFrom(null);
      reload();
    } catch (e) {
      message.error(e.message);
    } finally {
      setRenaming(false);
    }
  }

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!assignment)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const c = assignment.class;
  const sectionNames = assignment.sections.map((s) => s.section);
  // 目录选中项：改名/删板块后原名可能失效，回落第一个板块
  const currentSec =
    assignment.sections.find((s) => s.section === activeSection) || assignment.sections[0] || null;

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          ...(c ? [{ label: `${seriesLabel(c.series)} ${c.name}`, to: `/classes/${c.id}` }] : []),
          { label: `${assignment.unit_label} ${assignment.content}`.trim() },
        ]}
      />
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
        <div className="btn-row" style={{ marginTop: "var(--s4)" }}>
          <Link className="btn primary" to={`/grading/${assignment.id}`}>
            进入批改
          </Link>
          <button className="btn" onClick={() => setAiOpen(true)}>
            AI 录题
          </button>
          <button className="btn" onClick={() => setManualOpen(true)}>
            录题
          </button>
          <button className="btn" onClick={() => setEditOpen(true)}>
            编辑批次
          </button>
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
                <span className={`mono ${sub && sub.score !== null ? scoreTone(sub.score) : ""}`}>
                  {sub && sub.score !== null ? fmtScore(sub.score) : "—"}
                  {sub && sub.rating ? (
                    <span className={ratingTone(sub.rating_override || sub.rating)}>
                      {` · ${sub.rating_override || sub.rating}`}
                    </span>
                  ) : (
                    ""
                  )}
                </span>
              </div>
            );
          })}
          {students.length === 0 && <div className="row">暂无学生</div>}
        </section>

        <section className="block">
          <div className="sec-title">题库</div>
          {currentSec ? (
            <div className="qbank-layout">
              {/* 左：板块目录（sticky） */}
              <nav className="qbank-toc">
                {assignment.sections.map((sec) => (
                  <div
                    key={sec.section}
                    className={sec.section === currentSec.section ? "toc-item on" : "toc-item"}
                    onClick={() => setActiveSection(sec.section)}
                  >
                    <span className="toc-name">{sec.section}</span>
                    <span className="toc-count">{sec.question_count}</span>
                  </div>
                ))}
              </nav>
              {/* 右：当前板块题目 */}
              <div className="sec-card qbank-detail">
                <div className="qbank-sec-head">
                  <span className="row-name">
                    {currentSec.section}
                    <span>
                      {currentSec.question_count} 题 ·{" "}
                      {[...new Set(currentSec.questions.map((q) => modeLabel(q.mode)))].join(" / ")}
                    </span>
                  </span>
                  <span className="mono">权重 {currentSec.total_weight}</span>
                  <button
                    className="btn"
                    onClick={() => {
                      setRenameFrom(currentSec.section);
                      setRenameTo(currentSec.section);
                    }}
                  >
                    重命名
                  </button>
                  <button className="btn" onClick={() => setAddSection(currentSec.section)}>
                    + 加题
                  </button>
                </div>
                {currentSec.questions.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    actions={
                      <>
                        <button className="btn" onClick={() => setEditingQuestion(q)}>
                          编辑
                        </button>
                        <Popconfirm
                          title="删除该题？"
                          okText="删除"
                          cancelText="取消"
                          onConfirm={() => removeQuestion(q.id)}
                        >
                          <button className="btn">删除</button>
                        </Popconfirm>
                      </>
                    }
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="row">题库待录入</div>
          )}
        </section>
      </div>

      {c && (
        <AssignmentForm
          open={editOpen}
          onClose={() => setEditOpen(false)}
          classInfo={c}
          assignment={assignment}
          onSaved={reload}
        />
      )}
      <ManualEntryModal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        assignmentId={id}
        sections={sectionNames}
        onSaved={reload}
      />
      <ManualEntryModal
        open={addSection !== null}
        onClose={() => setAddSection(null)}
        assignmentId={id}
        sections={sectionNames}
        initialSection={addSection ?? undefined}
        onSaved={reload}
      />
      <AiEntryModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        assignmentId={id}
        sections={sectionNames}
        onSaved={reload}
      />
      <QuestionEditModal
        question={editingQuestion}
        sections={sectionNames}
        open={Boolean(editingQuestion)}
        onClose={() => setEditingQuestion(null)}
        onSaved={reload}
      />
      <Modal
        centered
        open={renameFrom !== null}
        onCancel={() => setRenameFrom(null)}
        onOk={renameSection}
        confirmLoading={renaming}
        title="重命名板块"
        okText="保存"
        cancelText="取消"
        width={400}
        destroyOnHidden
      >
        <Input
          value={renameTo}
          onChange={(e) => setRenameTo(e.target.value)}
          onPressEnter={renameSection}
          placeholder="板块名，如 Task 3 · 造句"
        />
      </Modal>
    </div>
  );
}
