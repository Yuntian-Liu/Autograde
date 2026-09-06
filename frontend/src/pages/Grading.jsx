import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { App as AntApp, Select } from "antd";
import { apiGet, apiPut } from "../api";
import AppHeader from "../components/AppHeader";
import QuestionEditor from "../components/QuestionEditor";
import { STATUS_META, deadlineText, fmtScore, modeLabel, seriesLabel } from "../meta";
import { RATINGS, ratingFor } from "../rating";
import "../grading.css";

const GRADED_STATUSES = new Set(["已批改", "缺作业"]);
const STATUS_OPTIONS = ["已批改", "缺作业", "未交", "待批改"].map((s) => ({ value: s, label: s }));

export default function Grading() {
  const { assignmentId } = useParams();
  const { message } = AntApp.useApp();

  const [assignment, setAssignment] = useState(null);
  const [students, setStudents] = useState([]);
  const [error, setError] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  // 勾选与定稿内容只存前端内存，「保存批改」时才落库；初始值取已入库的错题记录
  const [checkedMap, setCheckedMap] = useState({});
  const [notesMap, setNotesMap] = useState({});
  const [ratingOverrides, setRatingOverrides] = useState({});
  const [statusDrafts, setStatusDrafts] = useState({});
  const [editingQid, setEditingQid] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      apiGet(`/assignments/${assignmentId}`),
      apiGet(`/assignments/${assignmentId}/students`),
    ])
      .then(([a, s]) => {
        setAssignment(a);
        setStudents(s);
        const checked = {};
        const notes = {};
        for (const stu of s) {
          checked[stu.id] = [...stu.error_question_ids];
          notes[stu.id] = { ...stu.error_notes };
        }
        setCheckedMap(checked);
        setNotesMap(notes);
        const firstTodo = s.find((stu) => !stu.submission || stu.submission.status === "待批改");
        setCurrentId((firstTodo || s[0] || {}).id ?? null);
      })
      .catch((e) => setError(e.message));
  }, [assignmentId]);

  const questionById = useMemo(() => {
    const map = {};
    for (const sec of assignment?.sections || []) {
      for (const q of sec.questions) map[q.id] = q;
    }
    return map;
  }, [assignment]);

  const totalQuestions = Object.keys(questionById).length;
  const totalWeight = assignment?.total_weight || 0;

  const current = students.find((s) => s.id === currentId) || null;
  const checkedIds = current ? checkedMap[current.id] || [] : [];
  const checkedSet = useMemo(() => new Set(checkedIds), [checkedIds]);
  const currentNotes = current ? notesMap[current.id] || {} : {};

  const checkedWeight = checkedIds.reduce(
    (sum, qid) => sum + (questionById[qid]?.score_weight || 0),
    0
  );
  // 总分 100 按权重归一化，扣掉勾选错题权重，保留两位小数（与后端复算同规则）
  const score =
    totalWeight > 0 ? ((100 * (totalWeight - checkedWeight)) / totalWeight).toFixed(2) : "100.00";
  const autoRating = ratingFor(Number(score));
  const rating = (current && ratingOverrides[current.id]) || autoRating;

  // 本次保存要写入的提交状态：默认沿用已入库状态，未批过时默认「已批改」
  const statusDraft = current
    ? statusDrafts[current.id] ??
      (current.submission && current.submission.status !== "待批改"
        ? current.submission.status
        : "已批改")
    : "已批改";

  const gradedCount = students.filter(
    (s) => s.submission && GRADED_STATUSES.has(s.submission.status)
  ).length;

  function setCheckedFor(studentId, updater) {
    setCheckedMap((prev) => ({ ...prev, [studentId]: updater(prev[studentId] || []) }));
  }

  function toggleChip(qid) {
    if (!current) return;
    // 已勾选的芯片点击 = 弹出统一编辑窗；未勾选点击 = 勾上
    if (checkedSet.has(qid)) {
      setEditingQid(qid);
      return;
    }
    setCheckedFor(current.id, (ids) => [...ids, qid]);
    // 勾选变化后回到自动预选，清除手动覆盖
    setRatingOverrides((prev) => {
      const next = { ...prev };
      delete next[current.id];
      return next;
    });
  }

  function toggleGroup(section) {
    if (!current) return;
    const ids = section.questions.map((q) => q.id);
    const allOn = ids.every((qid) => checkedSet.has(qid));
    setCheckedFor(current.id, (prev) =>
      allOn ? prev.filter((x) => !ids.includes(x)) : [...new Set([...prev, ...ids])]
    );
  }

  function pickRating(r) {
    if (!current) return;
    setRatingOverrides((prev) => ({ ...prev, [current.id]: r }));
  }

  function saveNote(qid, note) {
    if (!current) return;
    setNotesMap((prev) => ({
      ...prev,
      [current.id]: { ...(prev[current.id] || {}), [qid]: note },
    }));
    setEditingQid(null);
  }

  function uncheckFromEditor(qid) {
    if (!current) return;
    setCheckedFor(current.id, (ids) => ids.filter((x) => x !== qid));
    setEditingQid(null);
  }

  // 反馈标题规则由后端定义（feedback.py），此处按返回字段拼装：
  // 厚少 {学生} U{n}L{m} 练习反馈；厚中 {学生} U{n}Day{m}[&U{n}B Preview] 伴学手册反馈
  function feedbackTitle() {
    if (!current || !assignment) return "";
    return `${current.name} ${assignment.unit_progress} ${assignment.class?.feedback_type || "反馈"}`;
  }

  // 只读预览：按板块分组拼装，verbatim 直出冻结解析，manual/ai_expand 用已定稿 note
  const previewBlocks = useMemo(() => {
    if (!assignment || !current) return [];
    const blocks = [];
    for (const sec of assignment.sections) {
      const picked = sec.questions.filter((q) => checkedSet.has(q.id));
      if (picked.length === 0) continue;
      blocks.push({
        section: sec.section,
        items: picked.map((q) => {
          const note = currentNotes[q.id];
          const text =
            q.mode === "verbatim"
              ? q.explanation
                ? `${q.seq}. ${q.explanation}`
                : null
              : note
                ? `${q.seq}. ${note}`
                : null;
          return { id: q.id, text, blank: `${sec.section} · 第 ${q.seq} 题 · 待填充` };
        }),
      });
    }
    return blocks;
  }, [assignment, current, checkedSet, currentNotes]);

  function buildPlainText() {
    if (!current || !assignment) return "";
    const lines = [feedbackTitle(), ""];
    for (const block of previewBlocks) {
      lines.push(`【${block.section} 部分】`);
      for (const item of block.items) lines.push(item.text ?? item.blank);
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(buildPlainText());
      message.success("已复制全部反馈");
    } catch {
      message.error("复制失败，请检查浏览器剪贴板权限");
    }
  }

  // 批改落库：分数/等级由后端按 score_weight 复算，成功后学生状态灯与分数改由后端数据驱动
  async function saveGrading() {
    if (!current || saving) return;
    setSaving(true);
    try {
      await apiPut(`/assignments/${assignment.id}/students/${current.id}/grading`, {
        status: statusDraft,
        checked_question_ids: checkedIds,
        rating_override: ratingOverrides[current.id] || "",
        notes: currentNotes,
        final_text: buildPlainText(),
      });
      const fresh = await apiGet(`/assignments/${assignmentId}/students`);
      setStudents(fresh);
      const me = fresh.find((s) => s.id === current.id);
      if (me) {
        setCheckedMap((prev) => ({ ...prev, [me.id]: [...me.error_question_ids] }));
        setNotesMap((prev) => ({ ...prev, [me.id]: { ...me.error_notes } }));
        setStatusDrafts((prev) => ({ ...prev, [me.id]: me.submission?.status || statusDraft }));
      }
      message.success(`已保存：${current.name}`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="page-error">加载失败：{error}</div>;
  if (!assignment) return null;

  const c = assignment.class;
  const editingQuestion = editingQid ? questionById[editingQid] : null;

  return (
    <>
      <AppHeader compact>
        <Link className="back" to={`/assignments/${assignment.id}`}>
          ← {assignment.unit_label}
        </Link>
        <span className="crumb">
          <b>{c ? `${seriesLabel(c.series)} ${c.name}` : ""}</b>
          <span className="sep">/</span>
          {assignment.unit_label} {assignment.content}
          <span className="sep">/</span>第 {assignment.lesson_no} 次课
        </span>
        {deadlineText(assignment.class_time) && (
          <span className="deadline">{deadlineText(assignment.class_time)}</span>
        )}
      </AppHeader>

      <main className="grading-main">
        {/* 左栏：学生名单 */}
        <section className="panel">
          <div className="panel-head">
            学生名单
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: students.length ? `${(gradedCount / students.length) * 100}%` : 0 }}
              />
            </div>
            <div className="progress-num">
              已批改 {gradedCount} / {students.length}
            </div>
          </div>
          {students.map((s) => {
            const sub = s.submission;
            const status = sub ? sub.status : "待批改";
            const state = (STATUS_META[status] || STATUS_META["待批改"]).state;
            return (
              <div
                key={s.id}
                className={s.id === currentId ? "stu active" : "stu"}
                onClick={() => setCurrentId(s.id)}
              >
                <span className={`state ${state}`} />
                <span className="name">{s.name}</span>
                {status === "缺作业" && <span className="tag-lack">缺项</span>}
                {status === "未交" && <span className="tag-miss">未交</span>}
                <span className="score">
                  {s.id === currentId
                    ? score
                    : sub && sub.score !== null
                      ? fmtScore(sub.score)
                      : "—"}
                </span>
              </div>
            );
          })}
        </section>

        {/* 中栏：学生信息栏 + 批改区 */}
        <section className="panel">
          {current && (
            <>
              <div className="stu-panel">
                <div className="stu-info">
                  <h1>{current.name}</h1>
                  <div className="stu-meta">
                    {c ? `${seriesLabel(c.series)} ${c.name}` : ""} · {assignment.unit_label}{" "}
                    {assignment.content} · 第 {assignment.lesson_no} 次课
                  </div>
                  <div className="stu-stats">
                    <div className="stat">
                      <div className="k">近 5 次平均</div>
                      <div className="v">{fmtScore(current.recent_avg_5)}</div>
                    </div>
                    <div className="stat">
                      <div className="k">上一次</div>
                      <div className="v">{fmtScore(current.last_score)}</div>
                    </div>
                    <div className="stat">
                      <div className="k">本次出勤</div>
                      <div className="v">已到</div>
                    </div>
                  </div>
                  {current.weak_sections.length > 0 && (
                    <div className="weak-tags">
                      {current.weak_sections.map((sec) => (
                        <span className="weak-tag" key={sec}>
                          薄弱 · {sec}
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="stu-note">{current.note || "+ 添加备注（仅自己可见）"}</span>
                </div>
                <div className="score-hero">
                  <div className="lab">当前分数 · 预览</div>
                  <div className="num">{score}</div>
                  <div className="of">
                    已勾选 {checkedIds.length} / {totalQuestions} 题
                  </div>
                </div>
              </div>

              <div className="rating-row">
                <span className="lab">等级</span>
                <div className="grade-pick">
                  {RATINGS.map((r) => (
                    <button
                      key={r}
                      className={r === rating ? "on" : ""}
                      onClick={() => pickRating(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <span className="auto-tag">
                  {ratingOverrides[current.id]
                    ? `已手动覆盖为 ${rating} · 自动预选 ${autoRating}`
                    : `已按 ${score} 自动预选 ${autoRating} · 可手动调整`}
                </span>
              </div>

              <div className="save-row">
                <span className="lab">提交状态</span>
                <Select
                  value={statusDraft}
                  onChange={(v) => setStatusDrafts((prev) => ({ ...prev, [current.id]: v }))}
                  options={STATUS_OPTIONS}
                  style={{ width: 110 }}
                />
                <button className="btn primary" onClick={saveGrading} disabled={saving}>
                  {saving ? "保存中…" : "保存批改"}
                </button>
              </div>

              {assignment.sections.map((sec) => {
                const ids = sec.questions.map((q) => q.id);
                const allOn = ids.length > 0 && ids.every((qid) => checkedSet.has(qid));
                const modes = [...new Set(sec.questions.map((q) => modeLabel(q.mode)))].join(" / ");
                return (
                  <div className="group" key={sec.section}>
                    <div className="group-head">
                      <span className="gname">{sec.section}</span>
                      <span className="gmeta">
                        {sec.question_count} 题 · {modes}
                      </span>
                      <span className="gact" onClick={() => toggleGroup(sec)}>
                        {allOn ? "清空" : "全选"}
                      </span>
                    </div>
                    <div className="chips">
                      {sec.questions.map((q) => (
                        <span
                          key={q.id}
                          className={checkedSet.has(q.id) ? "chip on" : "chip"}
                          onClick={() => toggleChip(q.id)}
                        >
                          {q.seq}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="pad-bottom" />
            </>
          )}
        </section>

        {/* 右栏：只读预览 */}
        <section className="panel">
          <div className="panel-head">
            反馈预览
            <div className="pv-actions">
              <button className="btn primary" onClick={copyAll}>
                复制全部
              </button>
            </div>
          </div>
          <div className="preview">
            {current && <h3>{feedbackTitle()}</h3>}
            {previewBlocks.map((block) => (
              <div key={block.section}>
                <h3>
                  <strong>{block.section} 部分</strong>
                </h3>
                {block.items.map((item) =>
                  item.text ? (
                    <p key={item.id}>{item.text}</p>
                  ) : (
                    <p key={item.id}>
                      <span className="blank">{item.blank}</span>
                    </p>
                  )
                )}
              </div>
            ))}
          </div>
        </section>
      </main>

      <QuestionEditor
        question={editingQuestion}
        note={editingQid ? currentNotes[editingQid] : ""}
        open={Boolean(editingQid)}
        onClose={() => setEditingQid(null)}
        onSave={(note) => saveNote(editingQid, note)}
        onUncheck={() => uncheckFromEditor(editingQid)}
      />
    </>
  );
}
