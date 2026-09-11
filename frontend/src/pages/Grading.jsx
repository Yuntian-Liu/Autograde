import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { App as AntApp, Input, Modal, Select } from "antd";
import { apiGet, apiPatch, apiPut } from "../api";
import AppHeader from "../components/AppHeader";
import QuestionEditor from "../components/QuestionEditor";
import {
  STATUS_META,
  deadlineText,
  fillIssuePlaceholders,
  fmtScore,
  greetingSlot,
  modeLabel,
  ratingTone,
  scoreTone,
  seriesLabel,
} from "../meta";
import { RATINGS, ratingFor } from "../rating";
import {
  buildFeedbackDoc,
  collapseBlankLines,
  docToHtml,
  docToText,
  sectionTitle,
  snapshotMatchesDoc,
} from "../utils/feedback";
import "../grading.css";

const PROCESSED_STATUSES = new Set(["已批改", "缺作业", "未交"]); // 唯一未处理状态是「待批改」
const STATUS_OPTIONS = ["已批改", "缺作业", "未交", "待批改"].map((s) => ({ value: s, label: s }));
const GREETING_SLOTS = ["早上", "中午", "下午", "晚上"];
// 「预习有错题」支持选错题数量（1-5），替换话术里的「错了1个小题」（对齐旧版 previewErrorCount）
const PREVIEW_ERROR_PHRASE = "预习有错题";
const PREVIEW_ERROR_COUNTS = [1, 2, 3, 4, 5];
// 十二档 → 评级话术分组（库内 8 组）：A- 并 A，B+/B/B- 并 B，C+/C/C- 并 C；「全对」组由分数=100 触发
const RATING_GROUP_ALIAS = { "A-": "A", "B+": "B", "B": "B", "B-": "B", "C+": "C", "C": "C", "C-": "C" };

export default function Grading() {
  const { assignmentId } = useParams();
  const [searchParams] = useSearchParams();
  const { message, modal } = AntApp.useApp();

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
  const [phrases, setPhrases] = useState([]);
  const [greetingId, setGreetingId] = useState(null);
  const [slot, setSlot] = useState(() => greetingSlot()); // 问候语时段：默认当前时段，可手选
  const [issuesMap, setIssuesMap] = useState({}); // studentId -> 已勾选 Issue 话术 id 列表
  const [issueParams, setIssueParams] = useState({}); // studentId -> { phraseId: 错题数量 }
  const [ratingPickId, setRatingPickId] = useState(null); // 抽中的评级话术 id（换学生/换分组重抽）
  const [lostSectionsMap, setLostSectionsMap] = useState({}); // studentId -> 失分板块手动改写（空 = 用自动值）
  const [lostOpen, setLostOpen] = useState(false); // 失分板块改写弹窗
  const [lostText, setLostText] = useState("");
  const [noteStudent, setNoteStudent] = useState(null); // 学生备注编辑目标
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [retroOpen, setRetroOpen] = useState(false); // 补录弹窗（线下已批，回填数据）
  const [retroText, setRetroText] = useState("");
  const [clearOpen, setClearOpen] = useState(false); // 清空勾选二次确认
  const [snapshotMap, setSnapshotMap] = useState({}); // studentId -> 最新反馈快照原文（落库真值）
  const [dirtyMap, setDirtyMap] = useState({}); // studentId -> 有未保存的表单编辑（脏标记）

  useEffect(() => {
    Promise.all([
      apiGet(`/assignments/${assignmentId}`),
      apiGet(`/assignments/${assignmentId}/students`),
      apiGet("/phrases").catch(() => []), // 话术失败不拖垮整页，Issue/问候语区退化为空
    ])
      .then(([a, s, p]) => {
        setAssignment(a);
        setStudents(s);
        setPhrases(p);
        // 问候语按当前时段随机取一条，存 state 保持稳定（换一条才变）
        const list = p.filter((x) => x.category === `问候语·${greetingSlot()}`);
        if (list.length) setGreetingId(list[Math.floor(Math.random() * list.length)].id);
        const checked = {};
        const notes = {};
        const snapshots = {};
        for (const stu of s) {
          checked[stu.id] = [...stu.error_question_ids];
          notes[stu.id] = { ...stu.error_notes };
          snapshots[stu.id] = stu.feedback_text ?? null;
        }
        setCheckedMap(checked);
        setNotesMap(notes);
        setSnapshotMap(snapshots);
        setDirtyMap({}); // 重新加载 = 与库内一致，全部干净
        const firstTodo = s.find((stu) => !stu.submission || stu.submission.status === "待批改");
        // 支持 ?student= 定位（题库答错名单跳来）；无参数或找不到回退原逻辑
        const want = Number(searchParams.get("student"));
        const target = want ? s.find((stu) => stu.id === want) : null;
        setCurrentId((target || firstTodo || s[0] || {}).id ?? null);
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

  // 存量快照剥离旧问候语：首行与任一「问候语·*」话术逐字匹配才剥（连同其后空行），
  // 误伤面为零；问候语不再进快照（见 saveGrading），此逻辑只为兼容 V0.2.0 前的存量
  function stripSnapshotGreeting(text) {
    if (!text) return text;
    const pool = phrases
      .filter((p) => p.category.startsWith("问候语·"))
      .map((p) => p.content.trim());
    const firstLine = text.split("\n", 1)[0].trim();
    if (!pool.includes(firstLine)) return text;
    return text.slice(text.indexOf("\n") + 1).replace(/^\n+/, "");
  }

  // 预览三态：有存档快照且未 dirty → 快照原文；无快照或表单已改 → 实时拼装
  const snapshotRaw = current ? snapshotMap[current.id] || null : null;
  const snapshot = snapshotRaw ? stripSnapshotGreeting(snapshotRaw) : null;
  const showSnapshot = Boolean(snapshot) && !dirtyMap[current?.id];

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

  const issuePhrases = useMemo(() => phrases.filter((p) => p.category === "Issue 模板"), [phrases]);
  const ratingPhrases = useMemo(() => phrases.filter((p) => p.category === "评级话术"), [phrases]);

  // 评级话术实时跟随：未交无话术；预览分 100 = 全对（优先于等级，手动覆盖等级不改变全对事实）；
  // 否则按生效等级（含手动覆盖）并档映射。100 分 ⇔ 未勾任何错题（权重恒正），预览分不含预习扣分
  const isPerfect = Number(score) === 100;
  const ratingGroup =
    statusDraft === "未交" ? null : isPerfect ? "全对" : RATING_GROUP_ALIAS[rating] || rating;

  // 失分板块自动值：勾选错题所在板块 → 剥「Task N · / Task N 」前缀 → 去重 → 按扣分权重降序
  const autoLostSections = useMemo(() => {
    if (!assignment) return "";
    const weightByName = new Map();
    for (const sec of assignment.sections) {
      let w = 0;
      for (const q of sec.questions) if (checkedSet.has(q.id)) w += q.score_weight;
      if (w <= 0) continue;
      const name =
        sec.section.replace(/^Task\s*\d+\s*[·•\-—.]?\s*/i, "").trim() || sec.section;
      weightByName.set(name, (weightByName.get(name) || 0) + w);
    }
    return [...weightByName.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).join("、");
  }, [assignment, checkedSet]);

  // 生效失分板块：手动改写优先（勾选变化不清除——定性归纳），空则回落自动值
  const manualLostSections = current ? lostSectionsMap[current.id] || "" : "";
  const lostSections = manualLostSections.trim() || autoLostSections;

  const ratingPhrase = useMemo(() => {
    const list = ratingPhrases.filter((p) => p.name === ratingGroup);
    const picked = list.find((p) => p.id === ratingPickId) || list[0];
    if (!picked) return "";
    return picked.content.replaceAll("{lost_sections}", lostSections || "部分题目");
  }, [ratingPhrases, ratingGroup, ratingPickId, lostSections]);

  // 分组或学生切换时从该组随机抽一条（与问候语 greetingId 同模式，避免 render 中随机的跳变）
  useEffect(() => {
    if (!ratingGroup) return;
    const list = ratingPhrases.filter((p) => p.name === ratingGroup);
    if (list.length) setRatingPickId(list[Math.floor(Math.random() * list.length)].id);
  }, [ratingGroup, currentId, ratingPhrases]);
  const urging = phrases.find((p) => p.category === "催交")?.content || "";
  const greetingList = phrases.filter((p) => p.category === `问候语·${slot}`);
  const greeting =
    greetingList.find((p) => p.id === greetingId)?.content || greetingList[0]?.content || "";
  const hasGreetings = phrases.some((p) => p.category.startsWith("问候语·"));

  const processedCount = students.filter(
    (s) => s.submission && PROCESSED_STATUSES.has(s.submission.status)
  ).length;

  function setCheckedFor(studentId, updater) {
    setCheckedMap((prev) => ({ ...prev, [studentId]: updater(prev[studentId] || []) }));
  }

  // 任何表单编辑动作都把当前学生标脏：有快照但 dirty 时预览切回实时拼装
  function markDirty() {
    if (!current) return;
    setDirtyMap((prev) => (prev[current.id] ? prev : { ...prev, [current.id]: true }));
  }

  function toggleChip(qid) {
    if (!current) return;
    // 已勾选的芯片点击 = 弹出统一编辑窗；未勾选点击 = 勾上
    if (checkedSet.has(qid)) {
      setEditingQid(qid);
      return;
    }
    setCheckedFor(current.id, (ids) => [...ids, qid]);
    markDirty();
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
    markDirty();
  }

  function pickRating(r) {
    if (!current) return;
    setRatingOverrides((prev) => ({ ...prev, [current.id]: r }));
    markDirty();
  }

  function saveNote(qid, note) {
    if (!current) return;
    setNotesMap((prev) => ({
      ...prev,
      [current.id]: { ...(prev[current.id] || {}), [qid]: note },
    }));
    setEditingQid(null);
    markDirty();
  }

  function uncheckFromEditor(qid) {
    if (!current) return;
    setCheckedFor(current.id, (ids) => ids.filter((x) => x !== qid));
    setEditingQid(null);
    markDirty();
  }

  function toggleIssue(phraseId) {
    if (!current) return;
    markDirty();
    const ids = issuesMap[current.id] || [];
    const unchecking = ids.includes(phraseId);
    setIssuesMap((prev) => ({
      ...prev,
      [current.id]: unchecking ? ids.filter((x) => x !== phraseId) : [...ids, phraseId],
    }));
    if (unchecking) {
      // 取消勾选时清掉该话术的参数
      setIssueParams((prev) => {
        const mine = { ...(prev[current.id] || {}) };
        delete mine[phraseId];
        return { ...prev, [current.id]: mine };
      });
    }
  }

  function setIssueCount(phraseId, n) {
    if (!current) return;
    setIssueParams((prev) => ({
      ...prev,
      [current.id]: { ...(prev[current.id] || {}), [phraseId]: n },
    }));
    markDirty();
  }

  function rerollGreeting() {
    if (greetingList.length < 2) return;
    const rest = greetingList.filter((p) => p.id !== greetingId);
    setGreetingId(rest[Math.floor(Math.random() * rest.length)].id);
  }

  function pickSlot(next) {
    setSlot(next);
    // 切换时段取该池第一条
    const list = phrases.filter((p) => p.category === `问候语·${next}`);
    setGreetingId(list[0]?.id ?? null);
  }

  // 反馈标题规则由后端定义（feedback.py），此处按返回字段拼装：
  // 厚少 {学生} U{n}L{m} 练习反馈；厚中 {学生} U{n}Day{m}[&U{n}B Preview] 伴学手册反馈
  function feedbackTitle() {
    if (!current || !assignment) return "";
    return `${current.name} ${assignment.unit_progress} ${assignment.class?.feedback_type || "反馈"}`;
  }

  // 反馈装配单一数据源（utils/feedback.js）：doc → 预览 / 纯文本 / HTML 三形态
  // 勾选的 Issue 话术 + 未交自动催交，追加到正文尾部（跟随保存进 final_text）
  const issueTexts = useMemo(() => {
    if (!current || !assignment) return [];
    const ids = issuesMap[current.id] || [];
    const params = issueParams[current.id] || {};
    const lines = issuePhrases
      .filter((p) => ids.includes(p.id))
      .map((p) => {
        let text = fillIssuePlaceholders(p.content, assignment, assignment.class);
        // 仅对选了数量的「预习有错题」替换计数，不误伤其他话术
        const n = params[p.id];
        if (n && p.name === PREVIEW_ERROR_PHRASE) {
          text = text.replace("错了1个小题", `错了${n}个小题`);
        }
        return text;
      });
    if (statusDraft === "未交" && urging) lines.push(urging);
    return lines;
  }, [current, assignment, issuesMap, issueParams, issuePhrases, statusDraft, urging]);

  const doc = useMemo(
    () =>
      buildFeedbackDoc({
        title: feedbackTitle(),
        ratingPhrase,
        sections: assignment?.sections,
        checkedSet,
        notes: currentNotes,
        issueTexts,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assignment, current, checkedSet, currentNotes, ratingPhrase, issueTexts]
  );

  // 快照判定：一致（正常保存）→ 结构化重渲染；不一致（补录/历史）→ 回退纯文本
  const snapshotMatches = showSnapshot && snapshotMatchesDoc(snapshot, doc);
  const snapshotDisplay = snapshot ? collapseBlankLines(snapshot) : null;

  function buildPlainText() {
    if (!current || !assignment) return "";
    return docToText(doc);
  }

  async function copyAll() {
    try {
      // 「复制反馈」双格式：text/html 保留加粗（微信笔记），text/plain 兜底；
      // 快照视图复制存档原文（剥离问候语后），结构一致时 HTML 走当前装配
      const text = showSnapshot ? snapshot : docToText(doc);
      const html =
        showSnapshot && !snapshotMatches
          ? snapshot
              .split("\n")
              .map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
              .join("<br>")
          : docToHtml(doc);
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      message.success("已复制反馈正文");
    } catch {
      // 老浏览器/权限问题回落纯文本
      try {
        await navigator.clipboard.writeText(showSnapshot ? snapshot : docToText(doc));
        message.success("已复制反馈正文");
      } catch {
        message.error("复制失败，请检查浏览器剪贴板权限");
      }
    }
  }

  async function copyGreeting() {
    try {
      await navigator.clipboard.writeText(greeting);
      message.success("已复制问候语");
    } catch {
      message.error("复制失败，请检查浏览器剪贴板权限");
    }
  }

  // 学生备注（仅自己可见）：批改页内直接编辑，成功后更新本地名单
  async function saveStudentNote() {
    if (!noteStudent) return;
    setNoteSaving(true);
    try {
      await apiPatch(`/students/${noteStudent.id}`, { note: noteText.trim() });
      setStudents((prev) =>
        prev.map((s) => (s.id === noteStudent.id ? { ...s, note: noteText.trim() } : s))
      );
      message.success("备注已保存");
      setNoteStudent(null);
    } catch (e) {
      message.error(e.message);
    } finally {
      setNoteSaving(false);
    }
  }

  // 失分板块手动改写：空串 = 回自动值（勾选变化不清除手动值，与等级覆盖的清除行为有意不同）
  function saveLostSections() {
    if (!current) return;
    setLostSectionsMap((prev) => ({ ...prev, [current.id]: lostText.trim() }));
    setLostOpen(false);
    markDirty();
  }

  // 清空当前学生勾选与已定稿内容（只动当前学生；标 dirty，保存时才落库）
  function clearCurrent() {
    if (!current) return;
    setCheckedMap((prev) => ({ ...prev, [current.id]: [] }));
    setNotesMap((prev) => ({ ...prev, [current.id]: {} }));
    markDirty();
    setClearOpen(false);
  }

  // 批改落库：分数/等级由后端按 score_weight 复算，成功后学生状态灯与分数改由后端数据驱动
  // finalOverride：补录模式粘贴的已有反馈全文（白名单——预览区始终只读，编辑只发生在表单弹窗）
  async function saveGrading(finalOverride = null) {
    if (!current || saving) return;
    // 改回「待批改」= 完整复位（清除错题/分数/快照），保存时二次确认防呆
    if (
      finalOverride === null &&
      statusDraft === "待批改" &&
      current.submission &&
      current.submission.status !== "待批改"
    ) {
      modal.confirm({
        title: "保存为待批改",
        content: "将清除该学生本次的批改记录（错题、分数、反馈快照），确认继续？",
        okText: "确认复位",
        cancelText: "取消",
        centered: true,
        okButtonProps: { danger: true },
        onOk: () => doSaveGrading(null),
      });
      return;
    }
    await doSaveGrading(finalOverride);
  }

  async function doSaveGrading(finalOverride = null) {
    if (!current || saving) return;
    setSaving(true);
    try {
      const body = buildPlainText();
      // 问候语不进快照：final_text 只存正文（标题+评级话术+题目+Issue）；
      // 补录模式（finalOverride）不变——老师粘什么存什么
      const finalText = finalOverride !== null ? finalOverride : body;
      // 本次用到的话术（问候/评级/Issue），驱动 use_count 越用越聪明；补录不计数
      const usedIds = finalOverride !== null ? [] : [
        ...(greetingId ? [greetingId] : greetingList[0]?.id ? [greetingList[0].id] : []),
        ...(ratingGroup && ratingPickId ? [ratingPickId] : []),
        ...(issuesMap[current.id] || []),
      ].filter(Boolean);
      await apiPut(`/assignments/${assignment.id}/students/${current.id}/grading`, {
        status: statusDraft,
        checked_question_ids: checkedIds,
        rating_override: ratingOverrides[current.id] || "",
        notes: currentNotes,
        final_text: finalText,
        used_phrase_ids: usedIds,
      });
      const fresh = await apiGet(`/assignments/${assignmentId}/students`);
      setStudents(fresh);
      // 快照回显：落库后预览立即显示存档原文；dirty 清除
      setSnapshotMap(Object.fromEntries(fresh.map((s) => [s.id, s.feedback_text ?? null])));
      setDirtyMap((prev) => ({ ...prev, [current.id]: false }));
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

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!assignment) {
    // 三栏骨架：数据未就绪时先占位，消灭白屏闪；与内容态同根节点，骨架→内容是内层替换不二次播放
    return (
      <div className="page-enter">
        <AppHeader compact />
        <main className="grading-main">
          {[0, 1, 2].map((i) => (
            <section className="panel" key={i}>
              <div className="panel-head">
                <div className="skel skel-line" />
              </div>
              <div style={{ padding: "var(--s4)" }}>
                <div className="skel skel-block" />
                <div className="skel skel-block" style={{ marginTop: "var(--s3)" }} />
              </div>
            </section>
          ))}
        </main>
      </div>
    );
  }

  const c = assignment.class;
  const editingQuestion = editingQid ? questionById[editingQid] : null;

  return (
    <div className="page-enter">
      <AppHeader
        compact
        crumbs={[
          { label: "工作台", to: "/" },
          ...(c ? [{ label: `${seriesLabel(c.series)} ${c.name}`, to: `/classes/${c.id}` }] : []),
          {
            label: `${assignment.unit_label} ${assignment.content}`.trim(),
            to: `/assignments/${assignment.id}`,
          },
          { label: "批改" },
        ]}
      >
        {deadlineText(assignment.class_time) && (
          <span className="deadline">{deadlineText(assignment.class_time)}</span>
        )}
      </AppHeader>

      <main className="grading-main">
        {/* 左栏：学生名单 */}
        <section className="panel">
          <div className="panel-back">
            <Link className="back" to={`/assignments/${assignment.id}`}>
              ← 返回批次
            </Link>
          </div>
          <div className="panel-head">
            学生名单
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: students.length ? `${(processedCount / students.length) * 100}%` : 0 }}
              />
            </div>
            <div className="progress-num">
              已处理 {processedCount} / {students.length}
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
                <span
                  className={`score ${
                    s.id === currentId
                      ? statusDraft === "未交"
                        ? ""
                        : scoreTone(score)
                      : sub && sub.score !== null
                        ? scoreTone(sub.score)
                        : ""
                  }`}
                >
                  {s.id === currentId
                    ? statusDraft === "未交"
                      ? "—"
                      : score
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
                    {assignment.content} · 第 {assignment.lesson_no} 次课 · #{assignment.id}
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
                  <span
                    className="stu-note clickable"
                    onClick={() => {
                      setNoteStudent(current);
                      setNoteText(current.note || "");
                    }}
                  >
                    {current.note || "+ 添加备注（仅自己可见）"}
                  </span>
                </div>
                <div className="score-hero">
                  <div className="lab">当前分数 · 预览</div>
                  <div className={`num ${statusDraft === "未交" ? "" : scoreTone(score)}`}>
                    {statusDraft === "未交" ? "—" : score}
                  </div>
                  <div className="of">
                    {statusDraft === "未交"
                      ? "未交 · 不计分"
                      : `已勾选 ${checkedIds.length} / ${totalQuestions} 题`}
                  </div>
                </div>
              </div>

              {statusDraft !== "未交" && (
                <div className="rating-row">
                  <span className="lab">等级</span>
                  <div className="grade-pick">
                    {RATINGS.map((r) => (
                      <button
                        key={r}
                        className={r === rating ? `on ${ratingTone(r)}`.trim() : ""}
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
              )}

              {statusDraft !== "未交" && !isPerfect && (
                <div className="lost-row">
                  <span className="lab">失分板块</span>
                  <button
                    className="lost-value"
                    onClick={() => {
                      setLostText(manualLostSections.trim() || autoLostSections);
                      setLostOpen(true);
                    }}
                  >
                    {lostSections}
                  </button>
                  <span className="auto-tag">
                    {manualLostSections.trim() ? "手动 · 清空恢复自动" : "自动 · 点击改写"}
                  </span>
                </div>
              )}

              <div className="save-row">
                <span className="lab">提交状态</span>
                <Select
                  value={statusDraft}
                  onChange={(v) => {
                    setStatusDrafts((prev) => ({ ...prev, [current.id]: v }));
                    markDirty();
                  }}
                  options={STATUS_OPTIONS}
                  style={{ width: 110 }}
                />
                <button className="btn primary" onClick={() => saveGrading()} disabled={saving}>
                  {saving ? "保存中…" : "保存批改"}
                </button>
                <button
                  className="btn"
                  disabled={saving}
                  title="线下已批改：勾选错题只为算分存档，反馈粘贴已发送的原文"
                  onClick={() => {
                    setRetroText("");
                    setRetroOpen(true);
                  }}
                >
                  补录保存
                </button>
                <button
                  className="btn danger"
                  style={{ marginLeft: "auto" }}
                  onClick={() => setClearOpen(true)}
                >
                  清空勾选
                </button>
              </div>

              {issuePhrases.length > 0 && (
                <div className="group">
                  <div className="group-head">
                    <span className="gname">情况</span>
                  </div>
                  <div className="chips">
                    {issuePhrases.map((p) => {
                      const on = (issuesMap[current.id] || []).includes(p.id);
                      const count = (issueParams[current.id] || {})[p.id] ?? 1;
                      return (
                        <span className="issue-item" key={p.id}>
                          <span
                            className={on ? "chip text on" : "chip text"}
                            onClick={() => toggleIssue(p.id)}
                          >
                            {p.name}
                          </span>
                          {on && p.name === PREVIEW_ERROR_PHRASE && (
                            <span className="slot-pick">
                              {PREVIEW_ERROR_COUNTS.map((n) => (
                                <span
                                  key={n}
                                  className={n === count ? "chip on" : "chip"}
                                  onClick={() => setIssueCount(p.id, n)}
                                >
                                  {n}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

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
          <div className="panel-head pv-head">
            反馈预览
            <button className="btn primary" onClick={copyAll}>
              复制反馈
            </button>
          </div>
          {hasGreetings && (
            <div className="greeting-box">
              <div className="greeting-bar">
                <span className="slot-pick">
                  {GREETING_SLOTS.map((s) => (
                    <span
                      key={s}
                      className={s === slot ? "chip text on" : "chip text"}
                      onClick={() => pickSlot(s)}
                    >
                      {s}
                    </span>
                  ))}
                </span>
                <span className="btn-row">
                  <button className="btn" onClick={rerollGreeting}>
                    换一条
                  </button>
                  <button className="btn primary" onClick={copyGreeting}>
                    复制问候语
                  </button>
                </span>
              </div>
              {greeting && <div className="greeting-text">{greeting}</div>}
            </div>
          )}
          <div className="preview">
            {showSnapshot && !snapshotMatches ? (
              // 补录/历史快照：回退纯文本（剥问候语 + 折叠连续空行，存档原文不动）
              <>
                <div>
                  <span className="snapshot-tag">已存档快照</span>
                </div>
                <p>{snapshotDisplay}</p>
              </>
            ) : (
              <>
                {showSnapshot && (
                  <div>
                    <span className="snapshot-tag">已存档快照</span>
                  </div>
                )}
                {current && (
                  <h3>
                    <strong>{doc.title}</strong>
                  </h3>
                )}
                {doc.ratingPhrase && <p className="rating-line">{doc.ratingPhrase}</p>}
                {doc.blocks.map((block) => (
                  <div key={block.section}>
                    <h3>
                      <strong>{sectionTitle(block.section)}</strong>
                    </h3>
                    {block.items.map((item) =>
                      item.kind === "answer" ? (
                        <div className="qitem" key={item.id}>
                          <div className="qitem-answer">
                            {item.seq}. <b>{item.answer}</b>
                          </div>
                          <div className="qitem-expl">{item.explanation}</div>
                        </div>
                      ) : item.text ? (
                        <p key={item.id}>{item.text}</p>
                      ) : (
                        <p key={item.id}>
                          <span className="blank">{item.blank}</span>
                        </p>
                      )
                    )}
                  </div>
                ))}
                {/* Issue 话术不加粗（加粗规格：仅标题/板块/答案） */}
                {doc.issues.map((text, i) => (
                  <p key={i}>{text}</p>
                ))}
              </>
            )}
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

      <Modal
        centered
        open={lostOpen}
        onCancel={() => setLostOpen(false)}
        onOk={saveLostSections}
        title="失分板块"
        okText="保存"
        cancelText="取消"
        width={400}
        destroyOnHidden
      >
        <Input
          value={lostText}
          onChange={(e) => setLostText(e.target.value)}
          onPressEnter={saveLostSections}
          placeholder="如 造句和语法"
        />
      </Modal>

      <Modal
        centered
        open={retroOpen}
        onCancel={() => setRetroOpen(false)}
        onOk={() => {
          setRetroOpen(false);
          saveGrading(retroText.trim());
        }}
        confirmLoading={saving}
        title={`补录保存 · ${current?.name}`}
        okText="补录落库"
        cancelText="取消"
        width={560}
        destroyOnHidden
      >
        <Input.TextArea
          value={retroText}
          onChange={(e) => setRetroText(e.target.value)}
          rows={10}
          placeholder={
            "粘贴已发送给家长的反馈全文（存档用）\n留空则只保存分数、等级与错题记录"
          }
        />
        <p className="login-hint">
          分数/等级仍按勾选错题自动复算；粘贴的原文原样存入反馈快照。
        </p>
      </Modal>

      <Modal
        centered
        open={clearOpen}
        onCancel={() => setClearOpen(false)}
        onOk={clearCurrent}
        okButtonProps={{ danger: true }}
        title="清空勾选"
        okText="确认清空"
        cancelText="取消"
        width={400}
        destroyOnHidden
      >
        <p className="danger-text">
          将清空当前学生（{current?.name}）的全部勾选与已定稿内容。
        </p>
      </Modal>

      <Modal
        centered
        open={noteStudent !== null}
        onCancel={() => setNoteStudent(null)}
        onOk={saveStudentNote}
        confirmLoading={noteSaving}
        title={noteStudent ? `${noteStudent.name} 的备注` : "备注"}
        okText="保存"
        cancelText="取消"
        width={400}
        destroyOnHidden
      >
        <Input.TextArea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          rows={4}
          placeholder="仅自己可见"
        />
      </Modal>
    </div>
  );
}
