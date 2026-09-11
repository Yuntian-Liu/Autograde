import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { App as AntApp, Input, Modal, Popconfirm, Popover } from "antd";
import { apiDelete, apiGet, apiPatch, apiPut } from "../api";
import AppHeader from "../components/AppHeader";
import AssignmentForm from "../components/AssignmentForm";
import QuestionCard from "../components/QuestionCard";
import QuestionEditModal from "../components/QuestionEdit";
import { AiEntryModal, ManualEntryModal } from "../components/QuestionEntry";
import PageSkeleton from "../components/PageSkeleton";
import { STATUS_META, deadlineText, fmtScore, modeLabel, ratingTone, scoreTone, seriesLabel } from "../meta";
import { IconGrip } from "../components/icons";
import { clientLog } from "../utils/clientLog";

function StatusDot({ status }) {
  const meta = STATUS_META[status] || STATUS_META["待批改"];
  return <span className={`state ${meta.state}`} />;
}

// 逐题正确率（已批改学生口径）：「正确率」小字标签 + 收紧的数字胶囊；点击弹答错名单，可点进常规批改页并选中该生
function RateCapsule({ q, assignmentId }) {
  const empty = q.correct_rate === null || q.correct_rate === undefined;
  const tone = empty ? "" : q.correct_rate >= 75 ? "tone-good" : q.correct_rate >= 60 ? "tone-mid" : "tone-bad";
  const label = empty ? "—" : `${Number(q.correct_rate).toFixed(2)}%`;
  const cap =
    !empty && q.wrong_students.length > 0 ? (
      <Popover
        trigger="click"
        title="答错名单"
        onOpenChange={(open) => {
          if (open) clientLog.add("ui", `查看正确率答错名单：批次${assignmentId} 题目${q.id}`);
        }}
        content={
          <div className="rate-pop">
            {q.wrong_students.map((s) => (
              <Link key={s.id} className="rate-pop-link" to={`/grading/${assignmentId}?student=${s.id}`}>
                {s.name}
              </Link>
            ))}
          </div>
        }
      >
        <button type="button" className={`rate-cap click ${tone}`}>
          {label}
        </button>
      </Popover>
    ) : (
      <span className={`rate-cap ${tone}`}>{label}</span>
    );
  return (
    <span className="rate-wrap">
      <span className="rate-lab">正确率</span>
      {cap}
    </span>
  );
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
  const [clearStep, setClearStep] = useState(0); // 清空题库双重确认：0=关 1=警示 2=输「清空」
  const [clearInput, setClearInput] = useState("");
  const [clearing, setClearing] = useState(false);
  // 板块拖拽排序：dragIdx = 拖起项；dropTarget = { idx, pos: before/after } 落点指示
  const [dragIdx, setDragIdx] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

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

  // 板块拖拽排序：把 dragIdx 项移动到 dropTarget 位置后整表提交
  async function reorderSections(from, to, pos) {
    const names = assignment.sections.map((s) => s.section);
    if (from === null || to === null || from === to) return;
    const [moved] = names.splice(from, 1);
    let insertAt = to > from ? to : to; // 移除后 to 指向同一逻辑位
    if (pos === "after" && to > from) insertAt = to; // 已前移一位，after 即原 to
    else if (pos === "after") insertAt = to + 1;
    names.splice(insertAt, 0, moved);
    try {
      await apiPut(`/assignments/${id}/sections-order`, { order: names });
      reload();
    } catch (e) {
      message.error(e.message);
    }
  }

  function endDrag(e) {
    e.currentTarget.closest(".toc-item")?.removeAttribute("draggable");
    setDragIdx(null);
    setDropTarget(null);
  }

  async function clearQuestionBank() {
    if (clearInput.trim() !== "清空") return;
    setClearing(true);
    try {
      await apiDelete(`/assignments/${id}/questions`);
      message.success("题库已清空，可重新录入");
      setClearStep(0);
      setClearInput("");
      reload();
    } catch (e) {
      message.error(e.message);
      setClearStep(0);
    } finally {
      setClearing(false);
    }
  }

  async function copyId(text) {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制 ${text}`);
    } catch {
      message.error("复制失败，请检查浏览器剪贴板权限");
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
          {" · "}
          <span
            className="mono id-chip"
            title="点击复制批次 ID"
            onClick={() => copyId(String(assignment.id))}
          >
            #{assignment.id}
          </span>
        </div>
        <div className="btn-row" style={{ marginTop: "var(--s4)" }}>
          <Link className="btn primary" to={`/grading/${assignment.id}`}>
            进入批改
          </Link>
          <Link className="btn" to={`/assignments/${assignment.id}/quick`}>
            快捷批改
          </Link>
          <button className="btn" onClick={() => setAiOpen(true)}>
            AI 录题
          </button>
          <button className="btn" onClick={() => setManualOpen(true)}>
            录题
          </button>
          {assignment.question_count > 0 && (
            <Link className="btn" to={`/assignments/${assignment.id}/edit`}>
              整批编辑
            </Link>
          )}
          <button className="btn" onClick={() => setEditOpen(true)}>
            编辑批次
          </button>
          {assignment.question_count > 0 && (
            <button
              className="btn danger"
              style={{ marginLeft: "auto" }}
              onClick={() => {
                setClearInput("");
                setClearStep(1);
              }}
            >
              清空题库
            </button>
          )}
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
                <span className={`mono score-col ${sub && sub.score !== null ? scoreTone(sub.score) : ""}`}>
                  {sub && sub.score !== null ? fmtScore(sub.score) : "—"}
                </span>
                <span className={`mono rating-col ${sub && sub.rating ? ratingTone(sub.rating_override || sub.rating) : ""}`}>
                  {sub && sub.rating ? `· ${sub.rating_override || sub.rating}` : ""}
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
              {/* 左：板块目录（sticky，拖住 ≡ 手柄上下拖动排序） */}
              <nav className="qbank-toc">
                {assignment.sections.map((sec, i) => (
                  <div
                    key={sec.section}
                    className={`toc-item ${sec.section === currentSec.section ? "on" : ""} ${
                      dragIdx === i ? "dragging" : ""
                    } ${dropTarget?.idx === i && dragIdx !== i ? `drop-${dropTarget.pos}` : ""}`}
                    onClick={() => setActiveSection(sec.section)}
                    onDragStart={(e) => {
                      setDragIdx(i);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(i));
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setDropTarget({ idx: i, pos: e.clientY < r.top + r.height / 2 ? "before" : "after" });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = Number(e.dataTransfer.getData("text/plain"));
                      reorderSections(from, i, dropTarget?.pos || "before");
                    }}
                    onDragEnd={endDrag}
                  >
                    <button
                      type="button"
                      className="toc-grip"
                      title="拖动排序"
                      onMouseDown={(e) => e.currentTarget.closest(".toc-item").setAttribute("draggable", "true")}
                    >
                      <IconGrip width={14} height={14} />
                    </button>
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
                        <RateCapsule q={q} assignmentId={id} />
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
        existingCount={assignment.question_count}
        onSaved={reload}
      />
      <ManualEntryModal
        open={addSection !== null}
        onClose={() => setAddSection(null)}
        assignmentId={id}
        sections={sectionNames}
        initialSection={addSection ?? undefined}
        existingCount={assignment.question_count}
        onSaved={reload}
      />
      <AiEntryModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        assignmentId={id}
        sections={sectionNames}
        existingCount={assignment.question_count}
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

      {/* 清空题库 · 第一重：红色警示列明后果 */}
      <Modal
        centered
        open={clearStep === 1}
        onCancel={() => setClearStep(0)}
        title={<span className="danger-title">清空本题库？</span>}
        width={440}
        destroyOnHidden
        footer={
          <div className="modal-actions">
            <button className="btn" onClick={() => setClearStep(0)}>
              取消
            </button>
            <button className="btn danger-solid" onClick={() => setClearStep(2)}>
              继续
            </button>
          </div>
        }
      >
        <p>此操作不可恢复，将永久删除本批次的：</p>
        <ul className="danger-list">
          <li>全部 {assignment.question_count} 道题目</li>
          <li>
            全部错题记录（含已批学生的勾选与定稿内容，共{" "}
            {assignment.graded_count > 0 ? `${students.filter((s) => s.submission).length} 名学生` : "0"} 名学生的批改数据）
          </li>
          <li>全部提交记录（分数 / 等级 / 提交状态）</li>
          <li>全部反馈快照</li>
        </ul>
        <p>批次本身保留，清空后可重新录题。若只想改题，请用「整批编辑」。</p>
      </Modal>

      {/* 清空题库 · 第二重：输入「清空」二字才可执行 */}
      <Modal
        centered
        open={clearStep === 2}
        onCancel={() => setClearStep(0)}
        title={<span className="danger-title">确认永久清空</span>}
        width={440}
        destroyOnHidden
        footer={
          <div className="modal-actions">
            <button className="btn" onClick={() => setClearStep(0)}>
              取消
            </button>
            <button
              className="btn danger-solid"
              disabled={clearInput.trim() !== "清空"}
              onClick={clearQuestionBank}
            >
              {clearing ? "清空中…" : "永久清空"}
            </button>
          </div>
        }
      >
        <div className="form-grid">
          <span className="flab">输入「清空」二字</span>
          <Input
            value={clearInput}
            onChange={(e) => setClearInput(e.target.value)}
            onPressEnter={clearQuestionBank}
            placeholder="清空"
          />
        </div>
      </Modal>
    </div>
  );
}
