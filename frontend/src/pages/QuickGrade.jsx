import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { App as AntApp } from "antd";
import { apiGet, apiPut } from "../api";
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import { STATUS_META, scoreTone, seriesLabel } from "../meta";
import { clientLog } from "../utils/clientLog";
import "../grading.css";

// 快捷批改：上半区答案速查（纯答案紧凑总览），下半区 学生×题目 标错矩阵
// 只管录入——微调/预览文本/话术都在常规批改页做
export default function QuickGrade() {
  const { id } = useParams();
  const { message } = AntApp.useApp();

  const [assignment, setAssignment] = useState(null);
  const [students, setStudents] = useState([]);
  const [error, setError] = useState(null);
  const [wrongMap, setWrongMap] = useState({}); // studentId -> Set(questionId) 标错
  const [dirtyMap, setDirtyMap] = useState({}); // studentId -> bool
  const [savingIds, setSavingIds] = useState(new Set());
  const [savingAll, setSavingAll] = useState(false);

  const load = useCallback(() => {
    Promise.all([apiGet(`/assignments/${id}`), apiGet(`/assignments/${id}/students`)])
      .then(([a, s]) => {
        setAssignment(a);
        setStudents(s);
        // 已批改学生的已记录错题预填进矩阵
        const wrong = {};
        for (const stu of s) wrong[stu.id] = new Set(stu.error_question_ids);
        setWrongMap(wrong);
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
    });
    const fresh = await apiGet(`/assignments/${id}/students`);
    setStudents(fresh);
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
      message.error(`保存失败：${failed.join("、")}`);
    } else {
      message.success(`已全部保存（${dirtyIds.length} 人）`);
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
  const dirtyCount = students.filter((s) => dirtyMap[s.id]).length;

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          ...(c ? [{ label: `${seriesLabel(c.series)} ${c.name}`, to: `/classes/${c.id}` }] : []),
          {
            label: `${assignment.unit_label} ${assignment.content}`.trim(),
            to: `/assignments/${assignment.id}`,
          },
          { label: "快捷批改" },
        ]}
      />
      <div className="wrap wrap-wide">
        <Link className="back" to={`/assignments/${assignment.id}`}>
          ← 返回批次
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>快捷批改 · {assignment.unit_label}</h1>

        {/* 上半区：答案速查（无解析无题干，纯答案紧凑总览） */}
        <section className="block">
          <div className="sec-title">答案速查</div>
          {assignment.sections.length === 0 && <div className="row">题库待录入</div>}
          <div className="qa-grid">
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
        {assignment.sections.length > 0 && (
          <section className="block">
            <div className="sec-title sec-title-row">
              标错矩阵
              <button
                className="btn primary"
                onClick={saveAll}
                disabled={savingAll || dirtyCount === 0}
              >
                {savingAll ? "保存中…" : `全部保存${dirtyCount ? `（${dirtyCount} 人有改动）` : ""}`}
              </button>
            </div>
            <div className="qg-scroll">
              <table className="qg-table">
                <thead>
                  <tr>
                    <th className="qg-stucol" />
                    {assignment.sections.map((sec) => (
                      <th className="qg-seclab" key={sec.section} colSpan={sec.questions.length}>
                        {sec.section}
                      </th>
                    ))}
                    <th className="qg-right qg-scorecol">分数</th>
                    <th className="qg-right qg-savecol" />
                  </tr>
                  <tr>
                    <th className="qg-stucol" />
                    {flatQuestions.map((q) => (
                      <th key={q.id}>{q.seq}</th>
                    ))}
                    <th className="qg-right qg-scorecol" />
                    <th className="qg-right qg-savecol" />
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => {
                    const sub = s.submission;
                    const status = sub ? sub.status : "待批改";
                    const state = (STATUS_META[status] || STATUS_META["待批改"]).state;
                    const score = scoreFor(s.id);
                    return (
                      <tr key={s.id} className={dirtyMap[s.id] ? "qg-dirty" : ""}>
                        <td className="qg-stucol">
                          <span className="qg-stu">
                            <span className={`state ${state}`} />
                            <span className="qg-name">{s.name}</span>
                          </span>
                        </td>
                        {flatQuestions.map((q) => (
                          <td key={q.id}>
                            <button
                              type="button"
                              className={(wrongMap[s.id] || new Set()).has(q.id) ? "qg-cell on" : "qg-cell"}
                              onClick={() => toggleCell(s.id, q.id)}
                            />
                          </td>
                        ))}
                        <td className={`qg-right qg-scorecol qg-score ${scoreTone(score)}`}>{score}</td>
                        <td className="qg-right qg-savecol">
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
