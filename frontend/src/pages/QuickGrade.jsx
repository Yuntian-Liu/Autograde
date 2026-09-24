import { IconChevronLeft } from "../components/icons";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { App as AntApp } from "antd";
import { apiGet, apiPut } from "../api";
import AppHeader from "../components/AppHeader";
import AIFloat from "../components/AIFloat";
import Confetti from "../components/Confetti";
import SaveStatus from "../components/SaveStatus";
import PageSkeleton from "../components/PageSkeleton";
import { STATUS_META, scoreTone, seriesLabel } from "../meta";
import { ratingFor } from "../rating";
import { clientLog } from "../utils/clientLog";
import { useAuth } from "../contexts/AuthContext";
import "../grading.css";

const PROCESSED_STATUSES = new Set(["已批改", "缺作业", "未交"]); // 唯一未处理状态是「待批改」

// 快捷批改：上半区答案速查（纯答案紧凑总览），下半区 学生×题目 标错矩阵
// 只管录入——微调/预览文本/话术都在常规批改页做
export default function QuickGrade() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const { user } = useAuth();

  const [assignment, setAssignment] = useState(null);
  const [students, setStudents] = useState([]);
  const [error, setError] = useState(null);
  const [wrongMap, setWrongMap] = useState({}); // studentId -> Set(questionId) 标错
  const [previewWrongMap, setPreviewWrongMap] = useState({}); // studentId -> Set(预习题号1-5) 标错（不计分）
  const [dirtyMap, setDirtyMap] = useState({}); // studentId -> bool
  const [savingIds, setSavingIds] = useState(new Set());
  const [savingAll, setSavingAll] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false); // 上次批量保存有失败（状态灯红灯）
  const [thresholds, setThresholds] = useState(null); // 生效分数线（null=用默认校准值）
  const [celebrate, setCelebrate] = useState(false); // 全班改完撒花（每次进页最多一次）
  const celebratedRef = useRef(false);

  const load = useCallback(() => {
    Promise.all([
      apiGet(`/assignments/${id}`),
      apiGet(`/assignments/${id}/students`),
      apiGet("/rating-thresholds").catch(() => null), // 分数线失败回退默认
    ])
      .then(([a, s, t]) => {
        setAssignment(a);
        setStudents(s);
        if (Array.isArray(t) && t.length) setThresholds(t.map((x) => [x.rating, x.min]));
        // 已批改学生的已记录错题预填进矩阵
        const wrong = {};
        const previewWrong = {};
        for (const stu of s) {
          wrong[stu.id] = new Set(stu.error_question_ids);
          previewWrong[stu.id] = new Set(stu.submission?.preview_wrong || []);
        }
        setWrongMap(wrong);
        setPreviewWrongMap(previewWrong);
        setDirtyMap({});
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // 拍平的题目序列（列顺序 = 板块分组顺序），与每题权重索引
  const flatQuestions = useMemo(
    () => (assignment?.sections || []).flatMap((sec) => sec.questions),
    [assignment]
  );
  const weightById = useMemo(
    () => Object.fromEntries(flatQuestions.map((q) => [q.id, q.score_weight])),
    [flatQuestions]
  );
  const totalWeight = assignment?.total_weight || 0;
  // 预习答题卡：has_preview 且 5 题答案录齐才开放预习列
  const previewAnswers = assignment?.preview_answers || [];
  const previewReady = Boolean(assignment?.has_preview) && previewAnswers.length === 5;

  // 十字准线：悬停格子的行（学生）/列（题目）高亮轨道，防止行多时看错列
  const [hover, setHover] = useState({ row: null, col: null });
  const colInSection = useMemo(() => {
    // 题目 id → 所属板块名（板块行 th 高亮用）
    const m = new Map();
    for (const sec of assignment?.sections || []) {
      for (const q of sec.questions) m.set(q.id, sec.section);
    }
    return m;
  }, [assignment]);

  function scoreFor(sid) {
    const wrong = wrongMap[sid] || new Set();
    let lost = 0;
    for (const qid of wrong) lost += weightById[qid] || 0;
    return totalWeight > 0 ? ((100 * (totalWeight - lost)) / totalWeight).toFixed(2) : "100.00";
  }

  function toggleCell(sid, qid) {
    setWrongMap((prev) => {
      const next = new Set(prev[sid] || []);
      if (next.has(qid)) next.delete(qid);
      else next.add(qid);
      return { ...prev, [sid]: next };
    });
    setDirtyMap((prev) => ({ ...prev, [sid]: true }));
  }

  function togglePreviewCell(sid, seq) {
    setPreviewWrongMap((prev) => {
      const next = new Set(prev[sid] || []);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return { ...prev, [sid]: next };
    });
    setDirtyMap((prev) => ({ ...prev, [sid]: true }));
  }

  // 全班改完撒花：仅当本次保存把处理数从 <总数 推到 =总数 时触发，每次进页最多一次
  function maybeCelebrate(fresh) {
    if (celebratedRef.current || !assignment) return;
    const total = fresh.length;
    if (total === 0) return;
    const nowDone = fresh.filter((s) => s.submission && PROCESSED_STATUSES.has(s.submission.status)).length;
    const prevDone = students.filter((s) => s.submission && PROCESSED_STATUSES.has(s.submission.status)).length;
    if (nowDone !== total || prevDone >= total) return;
    celebratedRef.current = true;
    setCelebrate(true);
    clientLog.add("ui", `全班批改完成庆祝：${assignment.unit_label}（${total} 人）`);
    modal.confirm({
      title: "全班批改完成 🎉",
      content: `${assignment.class ? `${seriesLabel(assignment.class.series)} ${assignment.class.name} · ` : ""}${assignment.unit_label}，全部 ${total} 份作业已处理。${user?.nickname || ""}老师辛苦了！`,
      okText: "回到批次",
      cancelText: "留在这里",
      centered: true,
      onOk: () => navigate(`/assignments/${assignment.slug || assignment.id}`),
    });
  }

  // 保存安全点：先拉该生现状取 notes/rating_override 透传（不清掉精修过的 note）；
  // PUT 落库成功后再重拉——状态灯/分数显示的是落库后的真值
  // final_text 传空串，后端跳过快照不覆盖已有反馈文本
  async function saveRow(sid) {
    const before = await apiGet(`/assignments/${id}/students`);
    const st = before.find((s) => s.id === sid);
    const sub = st?.submission;
    const status = sub && sub.status !== "待批改" ? sub.status : "已批改";
    await apiPut(`/assignments/${id}/students/${sid}/grading`, {
      status,
      checked_question_ids: [...(wrongMap[sid] || [])],
      rating_override: sub?.rating_override || "",
      notes: st?.error_notes || {},
      final_text: "",
      preview_wrong: [...(previewWrongMap[sid] || [])].sort((a, b) => a - b),
    });
    const fresh = await apiGet(`/assignments/${id}/students`);
    setStudents(fresh);
    maybeCelebrate(fresh);
    setDirtyMap((prev) => ({ ...prev, [sid]: false }));
  }

  async function saveOne(sid, name) {
    if (savingIds.has(sid)) return;
    setSavingIds((prev) => new Set(prev).add(sid));
    try {
      await saveRow(sid);
      clientLog.add("ui", `快捷批改保存：${name}`);
      message.success(`已保存：${name}`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(sid);
        return next;
      });
    }
  }

  async function saveAll() {
    const dirtyIds = students.filter((s) => dirtyMap[s.id]).map((s) => s.id);
    if (dirtyIds.length === 0) return message.success("没有待保存的改动");
    setSavingAll(true);
    const failed = [];
    for (const sid of dirtyIds) {
      try {
        await saveRow(sid);
      } catch (e) {
        failed.push(students.find((s) => s.id === sid)?.name || sid);
      }
    }
    setSavingAll(false);
    if (failed.length) {
      setSaveFailed(true);
      message.error(`保存失败：${failed.join("、")}`);
    } else {
      setSaveFailed(false);
      message.success(`已全部保存（${dirtyIds.length} 人）`);
    }
  }

  // 防丢保护：任何学生有未保存改动（含预习格）时，所有离开路径都要确认
  const blocking = Object.values(dirtyMap).some(Boolean);

  // ① 页面内导航拦截（返回批次/面包屑/任意路由跳转；useBlocker 需 data router）
  const blocker = useBlocker(blocking);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    modal.confirm({
      title: "有未保存的修改",
      content: "确定离开？未保存的修改将丢失。",
      okText: "离开",
      cancelText: "继续批改",
      centered: true,
      okButtonProps: { danger: true },
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);

  // ② 浏览器关标签/刷新拦截（无未保存改动/卸载时移除监听）
  useEffect(() => {
    if (!blocking) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [blocking]);

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
  const dirtyCount = students.filter((s) => dirtyMap[s.id]).length;

  return (
    <div className="page-enter">
      {celebrate && <Confetti />}
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          ...(c ? [{ label: `${seriesLabel(c.series)} ${c.name}`, to: `/classes/${c.id}` }] : []),
          {
            label: `${assignment.unit_label} ${assignment.content}`.trim(),
            to: `/assignments/${assignment.slug || assignment.id}`,
          },
          { label: "快捷批改" },
        ]}
      />
      <div className="wrap wrap-wide">
        <AIFloat assignmentId={assignment.id} />
        <Link className="back" to={`/assignments/${assignment.slug || assignment.id}`}>
          <IconChevronLeft />返回批次
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>快捷批改 · {assignment.unit_label}</h1>

        {/* 上半区：答案速查（无解析无题干，纯答案紧凑总览） */}
        <section className="block">
          <div className="sec-title">答案速查</div>
          {assignment.sections.length === 0 && <div className="row">题库待录入</div>}
          <div className="qa-grid">
            {assignment.has_preview && (
              <div className="qa-sec">
                <div className="qa-sec-name">
                  预习 · {assignment.unit_progress?.split("&")[1] || "Preview"}
                </div>
                {previewReady ? (
                  <div className="qa-chips">
                    {previewAnswers.map((ans, i) => (
                      <span className="qa-chip" key={i}>
                        <b>{i + 1}</b>
                        <span className="qa-ans">{ans}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <Link className="row" to={`/assignments/${assignment.slug || assignment.id}`}>
                    预习答案未录入
                  </Link>
                )}
              </div>
            )}
            {assignment.sections.map((sec) => (
              <div className="qa-sec" key={sec.section}>
                <div className="qa-sec-name">{sec.section}</div>
                <div className="qa-chips">
                  {sec.questions.map((q) => (
                    <span
                      className={`qa-chip${q.standard_answer.length > 12 ? " long" : ""}`}
                      key={q.id}
                    >
                      <b>{q.seq}</b>
                      <span className="qa-ans">{q.standard_answer}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 下半区：学生 × 题目 标错矩阵 */}
        {(assignment.sections.length > 0 || previewReady) && (
          <section className="block">
            <div className="sec-title sec-title-row">
              标错矩阵
              <SaveStatus dirty={dirtyCount > 0} saving={savingAll} failed={saveFailed} />
              <button
                className="btn primary"
                onClick={saveAll}
                disabled={savingAll || dirtyCount === 0}
              >
                {savingAll ? "保存中…" : `全部保存${dirtyCount ? `（${dirtyCount} 人有改动）` : ""}`}
              </button>
            </div>
            <div className="qg-scroll" onMouseLeave={() => setHover({ row: null, col: null })}>
              <table className="qg-table">
                <thead>
                  <tr>
                    <th className="qg-stucol" />
                    {assignment.sections.map((sec, si) => (
                      <Fragment key={sec.section}>
                        {si > 0 && <th className="qg-gap" />}
                        <th
                          className={
                            hover.col !== null && colInSection.get(hover.col) === sec.section
                              ? "qg-seclab qg-colhead"
                              : "qg-seclab"
                          }
                          colSpan={sec.questions.length}
                        >
                          {sec.section}
                        </th>
                      </Fragment>
                    ))}
                    {previewReady && (
                      <Fragment>
                        <th className="qg-gap" />
                        <th className="qg-seclab" colSpan={5}>
                          预习
                        </th>
                      </Fragment>
                    )}
                    <th className="qg-right qg-scorecol">分数</th>
                    <th className="qg-right qg-ratingcol">等级</th>
                    <th className="qg-right qg-savecol" />
                  </tr>
                  <tr>
                    <th className="qg-stucol" />
                    {assignment.sections.map((sec, si) => (
                      <Fragment key={sec.section}>
                        {si > 0 && <th className="qg-gap" />}
                        {sec.questions.map((q) => (
                          <th key={q.id} className={hover.col === q.id ? "qg-colhead" : undefined}>
                            {q.seq}
                          </th>
                        ))}
                      </Fragment>
                    ))}
                    {previewReady && (
                      <Fragment>
                        <th className="qg-gap" />
                        {[1, 2, 3, 4, 5].map((seq) => (
                          <th key={seq} className={hover.col === `p${seq}` ? "qg-colhead" : undefined}>
                            {seq}
                          </th>
                        ))}
                      </Fragment>
                    )}
                    <th className="qg-right qg-scorecol" />
                    <th className="qg-right qg-ratingcol" />
                    <th className="qg-right qg-savecol" />
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => {
                    const sub = s.submission;
                    const status = sub ? sub.status : "待批改";
                    const state = (STATUS_META[status] || STATUS_META["待批改"]).state;
                    const score = scoreFor(s.id);
                    const rowHot = hover.row === s.id;
                    return (
                      <tr key={s.id} className={dirtyMap[s.id] ? "qg-dirty" : ""}>
                        <td className={rowHot ? "qg-stucol qg-rowhead" : "qg-stucol"}>
                          <span className="qg-stu">
                            <span className={`state ${state}`} />
                            <Link className="qg-name" to={`/grading/${id}?student=${s.id}`} title={`${s.code ? `${s.code} · ` : ""}进入标准批改（定位该生）`}>{s.name}</Link>
                          </span>
                        </td>
                        {assignment.sections.map((sec, si) => (
                          <Fragment key={sec.section}>
                            {si > 0 && <td className="qg-gap" />}
                            {sec.questions.map((q) => {
                              const colHot = hover.col === q.id;
                              const cellCls = colHot && rowHot ? "qg-cross" : colHot ? "qg-colcell" : rowHot ? "qg-rowcell" : "";
                              return (
                                <td key={q.id} className={cellCls || undefined}>
                                  <button
                                    type="button"
                                    className={(wrongMap[s.id] || new Set()).has(q.id) ? "qg-cell on" : "qg-cell"}
                                    onClick={() => toggleCell(s.id, q.id)}
                                    onMouseEnter={() => setHover({ row: s.id, col: q.id })}
                                  />
                                </td>
                              );
                            })}
                          </Fragment>
                        ))}
                        {previewReady && (
                          <Fragment>
                            <td className="qg-gap" />
                            {[1, 2, 3, 4, 5].map((seq) => {
                              const colHot = hover.col === `p${seq}`;
                              const cellCls = colHot && rowHot ? "qg-cross" : colHot ? "qg-colcell" : rowHot ? "qg-rowcell" : "";
                              return (
                                <td key={seq} className={cellCls || undefined}>
                                  <button
                                    type="button"
                                    className={(previewWrongMap[s.id] || new Set()).has(seq) ? "qg-cell on" : "qg-cell"}
                                    onClick={() => togglePreviewCell(s.id, seq)}
                                    onMouseEnter={() => setHover({ row: s.id, col: `p${seq}` })}
                                  />
                                </td>
                              );
                            })}
                          </Fragment>
                        )}
                        <td
                          className={`qg-right qg-scorecol qg-score ${scoreTone(score)} ${rowHot ? "qg-rowhead" : ""}`}
                        >
                          {score}
                        </td>
                        <td className={`qg-right qg-ratingcol ${rowHot ? "qg-rowhead" : ""}`}>
                          <span className={`qg-ratecap ${scoreTone(score)}`}>
                            {ratingFor(Number(score), thresholds || undefined)}
                          </span>
                        </td>
                        <td className={rowHot ? "qg-right qg-savecol qg-rowhead" : "qg-right qg-savecol"}>
                          <button
                            className="btn"
                            disabled={savingIds.has(s.id) || savingAll}
                            onClick={() => saveOne(s.id, s.name)}
                          >
                            {savingIds.has(s.id) ? "…" : "保存"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
