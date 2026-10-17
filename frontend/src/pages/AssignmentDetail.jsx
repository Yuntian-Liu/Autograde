import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { App as AntApp, Input, Modal, Popconfirm, Popover } from "antd";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../api";
import AppHeader from "../components/AppHeader";
import AssignmentForm from "../components/AssignmentForm";
import InlineConfirm from "../components/bencho/InlineConfirm";
import QuestionCard from "../components/QuestionCard";
import QuestionEditModal from "../components/QuestionEdit";
import { AiEntryModal, ManualEntryModal } from "../components/QuestionEntry";
import PageSkeleton from "../components/PageSkeleton";
import PreviewEntry from "../components/PreviewEntry";
import StudentImportModal from "../components/StudentImportModal";
import CodeChip from "../components/CodeChip";
import { STATUS_META, deadlineText, fmtScore, modeLabel, ratingTone, scoreTone, seriesLabel } from "../meta";
import { IconChevronLeft, IconGrip } from "../components/icons";
import { clientLog } from "../utils/clientLog";

function StatusDot({ status }) {
  const meta = STATUS_META[status] || STATUS_META["待批改"];
  return <span className={`state ${meta.state}`} />;
}

// 提交状态胶囊（分数左侧固定列，四态统一胶囊格式，列才能对齐）
const STATUS_PILL = { 已批改: "ok", 待批改: "todo", 缺作业: "lack", 未交: "miss" };
const STATUS_PILL_TEXT = { 已批改: "正常", 待批改: "待批", 缺作业: "缺项", 未交: "未交" };

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

const DELETE_PHRASE = "确认删除批次";
const CLEAR_PHRASE = "确认清空题库";

export default function AssignmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [assignment, setAssignment] = useState(null);
  const [students, setStudents] = useState([]);
  const [error, setError] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false); // 预习答题卡
  const [importOpen, setImportOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [addSection, setAddSection] = useState(null); // 板块级「加题」预填板块名
  const [activeSection, setActiveSection] = useState(null); // 题库目录选中板块
  const [renameFrom, setRenameFrom] = useState(null); // 重命名板块：原名（null=关闭）
  const [renameTo, setRenameTo] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [clearStep, setClearStep] = useState(0); // 0=关 1=后果与短语 2=最终确认
  const [clearInput, setClearInput] = useState("");
  const [clearBusy, setClearBusy] = useState(false);
  const [deleteStep, setDeleteStep] = useState(0); // 0=关 1=后果 2=短语 3=最终确认
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
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

  function closeClear() {
    if (clearBusy) return;
    setClearStep(0);
    setClearInput("");
    setClearBusy(false);
  }

  function closeDelete() {
    if (deleteBusy) return;
    setDeleteStep(0);
    setDeleteInput("");
    setDeleteBusy(false);
  }

  async function clearQuestionBank() {
    if (clearInput !== CLEAR_PHRASE) throw new Error("确认短语不一致");
    await apiDelete(`/assignments/${id}/questions`);
    message.success("题库已清空，可重新录入");
    setClearStep(0);
    setClearInput("");
    setClearBusy(false);
    reload();
  }

  async function deleteAssignment() {
    if (deleteInput !== DELETE_PHRASE) throw new Error("确认短语不一致");
    await apiDelete(`/assignments/${assignment.id}`);
    message.success("批次已删除");
    setDeleteStep(0);
    setDeleteInput("");
    setDeleteBusy(false);
    const classInfo = assignment.class;
    navigate(classInfo?.is_temp ? "/temp" : classInfo ? `/classes/${classInfo.id}` : "/");
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
  const isTemp = Boolean(c?.is_temp);
  const hasStudents = students.length > 0;
  const assignmentTitle = `${isTemp && c?.name ? `${c.name} · ` : ""}${assignment.unit_label} ${assignment.content}`.trim();
  const sectionNames = assignment.sections.map((s) => s.section);
  // 目录选中项：改名/删板块后原名可能失效，回落第一个板块
  const currentSec =
    assignment.sections.find((s) => s.section === activeSection) || assignment.sections[0] || null;

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
          { label: `${assignment.unit_label} ${assignment.content}`.trim() },
        ]}
      />
      <div className="wrap wrap-wide">
        <Link className="back" to={isTemp ? "/temp" : c ? `/classes/${c.id}` : "/"}>
          <IconChevronLeft />{isTemp ? "临时批改" : c ? `${seriesLabel(c.series)} ${c.name}` : "返回"}
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>
          {isTemp && c?.name ? `${c.name} · ` : ""}{assignment.unit_label} {assignment.content}
        </h1>
        <div className="page-meta">
          {!isTemp && (
            <>
              第 {assignment.lesson_no} 次课
              {assignment.class_time ? ` · ${assignment.class_time}` : ""} ·{" "}
            </>
          )}
          {assignment.status}
          {!isTemp && deadlineText(assignment.class_time) ? ` · ${deadlineText(assignment.class_time)}` : ""}
          {" · "}
          <CodeChip code={assignment.code} />
        </div>
        {isTemp && assignment.note && <div className="assignment-note">{assignment.note}</div>}
        <div className="btn-row" style={{ marginTop: "var(--s4)" }}>
          {isTemp && !hasStudents ? (
            <Link className="btn primary" to={`/assignments/${assignment.slug || assignment.id}/quick`}>
              答案速查
            </Link>
          ) : (
            <>
              <Link className="btn primary" to={`/grading/${assignment.slug || assignment.id}`}>
                进入批改
              </Link>
              <Link className="btn" to={`/assignments/${assignment.slug || assignment.id}/quick`}>
                快捷批改
              </Link>
            </>
          )}
          <button className="btn" onClick={() => setAiOpen(true)}>
            AI 录题
          </button>
          <button className="btn" onClick={() => setManualOpen(true)}>
            录题
          </button>
          {assignment.has_preview && (
            <button className="btn" onClick={() => setPreviewOpen(true)}>
              预习答案{(assignment.preview_answers || []).length === 5 ? "（已录）" : ""}
            </button>
          )}
          {assignment.question_count > 0 && (
            <Link className="btn" to={`/assignments/${assignment.slug || assignment.id}/edit`}>
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
                setClearBusy(false);
                setClearStep(1);
              }}
            >
              清空题库
            </button>
          )}
          <button
            className="btn danger"
            style={assignment.question_count === 0 ? { marginLeft: "auto" } : undefined}
            onClick={() => {
              setDeleteInput("");
              setDeleteBusy(false);
              setDeleteStep(1);
            }}
          >
            删除批次
          </button>
        </div>

        <section className="block">
          <div className={isTemp ? "sec-title sec-title-row" : "sec-title"}>
            {isTemp ? "本批名单" : "学生提交状态"}
            {isTemp && (
              <button className="btn" onClick={() => setImportOpen(true)}>
                添加本批名单
              </button>
            )}
          </div>
          {students.map((s) => {
            const sub = s.submission;
            const status = sub ? sub.status : "待批改";
            return (
              <div className="row stu-grid-6" key={s.id}>
                <StatusDot status={status} />
                <span className="c-name" title={s.name}>
                  {s.name}
                </span>
                <CodeChip code={s.code} />
                <span />
                <span className={`tag-pill ${STATUS_PILL[status] || "todo"}`}>
                  {STATUS_PILL_TEXT[status] || "待批"}
                </span>
                <span className={`mono score-col ${sub && sub.score !== null ? scoreTone(sub.score) : ""}`}>
                  {sub && sub.score !== null ? fmtScore(sub.score) : "—"}
                </span>
                <span className={`mono rating-col ${sub && sub.rating ? ratingTone(sub.rating_override || sub.rating) : ""}`}>
                  {sub && sub.rating ? `· ${sub.rating_override || sub.rating}` : ""}
                </span>
              </div>
            );
          })}
          {students.length === 0 && <div className="row">{isTemp ? "暂无本批名单" : "暂无学生"}</div>}
        </section>

        <section className="block">
          <div className="sec-title">题库</div>
          {assignment.has_preview && (
            <div className="qa-sec" style={{ marginBottom: "var(--s3)" }}>
              <div className="qa-sec-name">预习 · {assignment.unit_progress?.split("&")[1] || "Preview"}</div>
              {(assignment.preview_answers || []).length === 5 ? (
                <div className="qa-chips">
                  {assignment.preview_answers.map((ans, i) => (
                    <span className="qa-chip" key={i}>
                      <b>{i + 1}</b>
                      <span className="qa-ans">{ans}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="row">预习答案未录入，点上方「预习答案」登记</div>
              )}
            </div>
          )}
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
          temp={isTemp}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          classInfo={c}
          assignment={assignment}
          onSaved={reload}
        />
      )}
      {isTemp && (
        <StudentImportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          students={students}
          title="添加本批名单"
          existingLabel="本批已有"
          onImport={(names, allowDuplicates) =>
            apiPost(`/assignments/${assignment.id}/students/batch`, {
              names,
              allow_duplicates: allowDuplicates,
            })
          }
          onImported={reload}
        />
      )}
      <ManualEntryModal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        assignmentId={assignment.id}
        sections={sectionNames}
        existingCount={assignment.question_count}
        onSaved={reload}
      />
      <ManualEntryModal
        open={addSection !== null}
        onClose={() => setAddSection(null)}
        assignmentId={assignment.id}
        sections={sectionNames}
        initialSection={addSection ?? undefined}
        existingCount={assignment.question_count}
        onSaved={reload}
      />
      <AiEntryModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        assignmentId={assignment.id}
        sections={sectionNames}
        existingCount={assignment.question_count}
        onSaved={reload}
      />
      <PreviewEntry
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        assignment={assignment}
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

      {/* 清空题库 · 第一段：后果清单与逐字确认 */}
      <Modal
        centered
        open={clearStep === 1}
        onCancel={closeClear}
        title={<span className="danger-title">清空本题库？</span>}
        width={440}
        destroyOnHidden
        footer={
          <div className="modal-actions">
            <button className="btn" onClick={closeClear}>
              取消
            </button>
            <button
              className="btn danger-solid"
              disabled={clearInput !== CLEAR_PHRASE}
              onClick={() => setClearStep(2)}
            >
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
        <p>批次本身和学生名单保留，清空后可重新录题。若只想改题，请用「整批编辑」。</p>
        <div className="form-grid">
          <span className="flab">点击填入</span>
          <button type="button" className="btn danger" onClick={() => setClearInput(CLEAR_PHRASE)}>
            {CLEAR_PHRASE}
          </button>
          <span className="flab">逐字输入</span>
          <Input
            value={clearInput}
            onChange={(e) => setClearInput(e.target.value)}
            onPressEnter={() => {
              if (clearInput === CLEAR_PHRASE) setClearStep(2);
            }}
            placeholder={CLEAR_PHRASE}
          />
        </div>
      </Modal>

      {/* 清空题库 · 第二段：保险丝烧尽后才提交 */}
      <Modal
        centered
        open={clearStep === 2}
        onCancel={closeClear}
        title={<span className="danger-title">最后确认永久清空</span>}
        width={440}
        destroyOnHidden
        maskClosable={!clearBusy}
        keyboard={!clearBusy}
        closable={!clearBusy}
        footer={
          <div className="modal-actions" style={{ alignItems: "center" }}>
            <button className="btn" disabled={clearBusy} onClick={closeClear}>
              取消
            </button>
            <InlineConfirm
              label="永久清空"
              doneLabel="已清空"
              pendingLabel="清空中…"
              danger
              height={44}
              grace={4000}
              onCommit={clearQuestionBank}
              onBusyChange={setClearBusy}
            />
          </div>
        }
      >
        <p className="danger-title">
          <strong>最后警示：题库清空后无法恢复。</strong>
        </p>
        <p>点击「永久清空」后可在 4 秒内撤销；倒计时结束才会正式清空。</p>
      </Modal>

      {/* 删除批次 · 第一段：列明批次与全部后果 */}
      <Modal
        centered
        open={deleteStep === 1}
        onCancel={closeDelete}
        title={<span className="danger-title">删除批次？</span>}
        width={440}
        destroyOnHidden
        footer={
          <div className="modal-actions">
            <button className="btn" onClick={closeDelete}>
              取消
            </button>
            <button className="btn danger-solid" onClick={() => setDeleteStep(2)}>
              继续
            </button>
          </div>
        }
      >
        <div style={{ marginBottom: "var(--s3)" }}>
          <strong>{assignmentTitle}</strong>
          <div className="page-meta">
            <CodeChip code={assignment.code} />
          </div>
        </div>
        <p className="danger-title">
          <strong>此操作不可恢复，将永久删除该批次及其：</strong>
        </p>
        <ul className="danger-list">
          <li>全部 {assignment.question_count} 道题目</li>
          <li>全部错题记录（含已批学生的勾选与定稿内容）</li>
          <li>全部提交记录（分数 / 等级 / 提交状态）</li>
          <li>全部反馈快照</li>
          {isTemp && <li>本批名单（{students.length} 名学生）</li>}
        </ul>
      </Modal>

      {/* 删除批次 · 第二段：二次警示与逐字确认 */}
      <Modal
        centered
        open={deleteStep === 2}
        onCancel={closeDelete}
        title={<span className="danger-title">再次确认删除批次</span>}
        width={440}
        destroyOnHidden
        footer={
          <div className="modal-actions">
            <button className="btn" onClick={closeDelete}>
              取消
            </button>
            <button
              className="btn danger-solid"
              disabled={deleteInput !== DELETE_PHRASE}
              onClick={() => setDeleteStep(3)}
            >
              继续
            </button>
          </div>
        }
      >
        <p className="danger-title">
          <strong>该批次及上述全部数据将被永久删除，无法找回。</strong>
        </p>
        <p>
          <strong>{assignmentTitle}</strong>
        </p>
        <div className="form-grid">
          <span className="flab">点击填入</span>
          <button type="button" className="btn danger" onClick={() => setDeleteInput(DELETE_PHRASE)}>
            {DELETE_PHRASE}
          </button>
          <span className="flab">逐字输入</span>
          <Input
            value={deleteInput}
            onChange={(e) => setDeleteInput(e.target.value)}
            onPressEnter={() => {
              if (deleteInput === DELETE_PHRASE) setDeleteStep(3);
            }}
            placeholder={DELETE_PHRASE}
          />
        </div>
      </Modal>

      {/* 删除批次 · 第三段：保险丝烧尽后才提交 */}
      <Modal
        centered
        open={deleteStep === 3}
        onCancel={closeDelete}
        title={<span className="danger-title">最后确认永久删除</span>}
        width={440}
        destroyOnHidden
        maskClosable={!deleteBusy}
        keyboard={!deleteBusy}
        closable={!deleteBusy}
        footer={
          <div className="modal-actions" style={{ alignItems: "center" }}>
            <button className="btn" disabled={deleteBusy} onClick={closeDelete}>
              取消
            </button>
            <InlineConfirm
              label="永久删除"
              doneLabel="已删除"
              pendingLabel="删除中…"
              danger
              height={44}
              grace={4000}
              onCommit={deleteAssignment}
              onBusyChange={setDeleteBusy}
            />
          </div>
        }
      >
        <p className="danger-title">
          <strong>最后警示：永久删除后无法找回。</strong>
        </p>
        <p>
          <strong>{assignmentTitle}</strong>
        </p>
        <p>点击「永久删除」后可在 4 秒内撤销；倒计时结束才会向服务器提交删除。</p>
      </Modal>
    </div>
  );
}
