import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { App as AntApp } from "antd";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import { STATUS_META, deadlineText, fmtScore, modeLabel, seriesLabel } from "../meta";
import { RATINGS, ratingFor } from "../rating";
import "../grading.css";

const GRADED_STATUSES = new Set(["已批改", "缺作业"]);

export default function Grading() {
  const { assignmentId } = useParams();
  const { message } = AntApp.useApp();

  const [assignment, setAssignment] = useState(null);
  const [students, setStudents] = useState([]);
  const [error, setError] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  // 勾选状态只存前端内存（studentId -> questionId[]），初始值取已入库的错题记录
  const [checkedMap, setCheckedMap] = useState({});
  const [ratingOverrides, setRatingOverrides] = useState({});

  useEffect(() => {
    Promise.all([
      apiGet(`/assignments/${assignmentId}`),
      apiGet(`/assignments/${assignmentId}/students`),
    ])
      .then(([a, s]) => {
        setAssignment(a);
        setStudents(s);
        const initial = {};
        for (const stu of s) initial[stu.id] = [...stu.error_question_ids];
        setCheckedMap(initial);
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

  const checkedWeight = checkedIds.reduce(
    (sum, qid) => sum + (questionById[qid]?.score_weight || 0),
    0
  );
  // 总分 100 按权重归一化，扣掉勾选错题权重，保留两位小数
  const score =
    totalWeight > 0 ? ((100 * (totalWeight - checkedWeight)) / totalWeight).toFixed(2) : "100.00";
  const autoRating = ratingFor(Number(score));
  const rating = (current && ratingOverrides[current.id]) || autoRating;

  const gradedCount = students.filter(
    (s) => s.submission && GRADED_STATUSES.has(s.submission.status)
  ).length;

  function setCheckedFor(studentId, updater) {
    setCheckedMap((prev) => ({ ...prev, [studentId]: updater(prev[studentId] || []) }));
  }

  function toggleChip(qid) {
    if (!current) return;
    setCheckedFor(current.id, (ids) =>
      ids.includes(qid) ? ids.filter((x) => x !== qid) : [...ids, qid]
    );
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

  // 只读预览：按板块分组拼装，verbatim 直出冻结解析，其余留待填充位
  const previewBlocks = useMemo(() => {
    if (!assignment || !current) return [];
    const blocks = [];
    for (const sec of assignment.sections) {
      const picked = sec.questions.filter((q) => checkedSet.has(q.id));
      if (picked.length === 0) continue;
      blocks.push({
        section: sec.section,
        items: picked.map((q) => ({
          id: q.id,
          text:
            q.mode === "verbatim" && q.explanation
              ? `${q.seq}. ${q.explanation}`
              : null,
          blank: `${sec.section} · 第 ${q.seq} 题 · 待填充`,
        })),
      });
    }
    return blocks;
  }, [assignment, current, checkedSet]);

  function buildPlainText() {
    if (!current || !assignment) return "";
    const lines = [`${current.name} ${assignment.unit_label} ${assignment.content}反馈`, ""];
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

  if (error) return <div className="page-error">加载失败：{error}</div>;
  if (!assignment) return null;

  const c = assignment.class;

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
            {current && (
              <h3>
                {current.name} {assignment.unit_label} {assignment.content}反馈
              </h3>
            )}
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
    </>
  );
}
