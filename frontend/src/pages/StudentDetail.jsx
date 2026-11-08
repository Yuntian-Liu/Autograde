import { IconChevronLeft } from "../components/icons";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
} from "recharts";
import { apiGet } from "../api";
import AbilityReportModal from "../components/AbilityReportModal";
import AppHeader from "../components/AppHeader";
import CodeChip from "../components/CodeChip";
import PageSkeleton from "../components/PageSkeleton";
import ScoreViewToggle from "../components/ScoreViewToggle";
import { useScoreView } from "../contexts/ScoreViewContext";
import { fmtGpa } from "../gpa";
import { fmtScore, fmtTime, scoreColorVar, scoreTone, seriesLabel } from "../meta";
import { rangeLabel } from "../utils/ability";
import { batchStatus, computeLeaderboard } from "../utils/leaderboard";

const GRADED = new Set(["已批改", "缺作业"]);

// 学生详情页：信息头 + 历次成绩趋势 + 名次走势 + 薄弱板块 + 明细表
export default function StudentDetail() {
  const { classId, studentId } = useParams();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [classInfo, setClassInfo] = useState(null);
  const [lb, setLb] = useState(null);
  const [reports, setReports] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [error, setError] = useState(null);
  const { isGpa } = useScoreView();

  function loadReports() {
    return apiGet(`/students/${studentId}/ability-reports`).then(setReports);
  }

  useEffect(() => {
    Promise.all([
      apiGet(`/students/${studentId}/stats`),
      apiGet(`/classes/${classId}`),
      apiGet(`/classes/${classId}/leaderboard`),
      apiGet(`/students/${studentId}/ability-reports`),
    ])
      .then(([s, c, l, r]) => {
        setStats(s);
        setClassInfo(c);
        setLb(l);
        setReports(r);
      })
      .catch((e) => setError(e.message));
  }, [classId, studentId]);

  const scored = useMemo(
    () => (stats?.history || []).filter((h) => GRADED.has(h.status) && h.score !== null),
    [stats]
  );
  const recent5 = scored.slice(-5);
  const recentAvg5 = scored.length
    ? (recent5.reduce((sum, h) => sum + h.score, 0) / recent5.length).toFixed(2)
    : null;
  const recentGpas = recent5.filter((h) => h.gpa !== null && h.gpa !== undefined);
  const recentAvgGpa = recentGpas.length
    ? recentGpas.reduce((sum, h) => sum + h.gpa, 0) / recentGpas.length
    : null;
  const lastScore = scored.length ? scored[scored.length - 1].score : null;
  const lastGpa = scored.length ? scored[scored.length - 1].gpa : null;

  const trendData = useMemo(
    () =>
      (stats?.history || []).map((h) => {
        const score = GRADED.has(h.status) && h.score !== null ? Number(h.score) : null;
        const gpa = score !== null && h.gpa !== null && h.gpa !== undefined ? Number(h.gpa) : null;
        return { label: h.unit_label, score, gpa, value: isGpa ? gpa : score, status: h.status };
      }),
    [stats, isGpa]
  );

  // 班级排名（实时口径）与名次走势（历次·含提交率，按已完成批次逐个截断重算）
  const sid = Number(studentId);
  const view = isGpa ? "gpa" : "score";
  const liveRank = useMemo(() => {
    if (!lb) return null;
    const rows = computeLeaderboard(lb.batches, lb.students, { live: true, view });
    const me = rows.find((r) => r.student_id === sid);
    return me ? { rank: me.rank, total: rows.length } : null;
  }, [lb, sid, view]);
  const rankTrend = useMemo(() => {
    if (!lb) return [];
    const done = lb.batches.filter((b) => batchStatus(b) === "已完成");
    return done.map((_, i) => {
      const rows = computeLeaderboard(lb.batches, lb.students, {
        live: false,
        upto: i + 1,
        weighted: true,
        view,
      });
      const me = rows.find((r) => r.student_id === sid);
      const hasScore = me && (isGpa ? me.avg_gpa !== null : me.avg !== null);
      return { label: `第 ${i + 1} 次`, rank: hasScore ? me.rank : null };
    });
  }, [lb, sid, view, isGpa]);

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!stats || !classInfo || !lb)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const s = stats.student;

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          { label: `${seriesLabel(classInfo.series)} ${classInfo.name}`, to: `/classes/${classInfo.id}` },
          { label: s.name },
        ]}
      />
      <div className="wrap">
        <Link className="back" to={`/classes/${classInfo.id}`}>
          <IconChevronLeft />返回班级
        </Link>

        {/* 学生信息头 */}
        <div className="stu-panel sd-head">
          <div className="stu-info">
            <h1>{s.name}</h1>
            <div className="stu-meta" style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
              <CodeChip code={s.code} />
              {s.note && <span>{s.note}</span>}
            </div>
            <div className="stu-stats">
              <div className="stat" title={isGpa ? `原平均分 ${recentAvg5 || "—"}` : undefined}>
                <div className="k">{isGpa ? "近 5 次平均 GPA" : "近 5 次平均"}</div>
                <div className="v">{isGpa ? fmtGpa(recentAvgGpa) : fmtScore(recentAvg5)}</div>
              </div>
              <div className="stat" title={isGpa ? `原分数 ${fmtScore(lastScore)}` : undefined}>
                <div className="k">{isGpa ? "上一次 GPA" : "上一次"}</div>
                <div className="v">{isGpa ? fmtGpa(lastGpa) : fmtScore(lastScore)}</div>
              </div>
              <div className="stat">
                <div className="k">作业次数</div>
                <div className="v">{stats.history.length}</div>
              </div>
              {liveRank && (
                <div className="stat">
                  <div className="k">班级排名</div>
                  <div className="v">
                    第 {liveRank.rank} / {liveRank.total} 名
                  </div>
                </div>
              )}
              <div className="stat">
                <div className="k">视图</div>
                <ScoreViewToggle />
              </div>
            </div>
          </div>
        </div>

        {/* 历次作业趋势 */}
        <section className="block">
          <div className="sec-title">{isGpa ? "历次 GPA 趋势" : "历次成绩趋势"}</div>
          {trendData.length === 0 ? (
            <div className="row">暂无数据</div>
          ) : (
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={trendData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, isGpa ? 4.33 : 100]} tick={{ fontSize: 11 }} width={36} />
                  <Tooltip
                    formatter={(v, _n, item) => [
                      v === null ? "—" : `${Number(v).toFixed(2)}${isGpa ? ` · 原分数 ${fmtScore(item.payload.score)}` : ""}`,
                      `${isGpa ? "GPA" : "分数"}（${item.payload.status}）`,
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    connectNulls={false}
                    dot={(props) => {
                      const { cx, cy, payload, index } = props;
                      if (payload.value === null) return <g key={index} />;
                      return (
                        <circle
                          key={index}
                          cx={cx}
                          cy={cy}
                          r={4}
                          fill={scoreColorVar(payload.score)}
                          stroke="var(--surface)"
                          strokeWidth={1.5}
                        />
                      );
                    }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* 名次走势（历次·含提交率口径，仅已完成批次） */}
        {rankTrend.length > 0 && (
          <section className="block">
            <div className="sec-title">名次走势</div>
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={rankTrend} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis
                    reversed
                    domain={[1, Math.max(1, lb.students.length)]}
                    allowDecimals={false}
                    tick={{ fontSize: 11 }}
                    width={36}
                  />
                  <Tooltip formatter={(v) => [`第 ${v} 名`, "名次"]} />
                  <Line
                    type="monotone"
                    dataKey="rank"
                    name="名次"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    connectNulls={false}
                    dot={{ r: 4, fill: "var(--accent)", strokeWidth: 0 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {/* 薄弱板块 */}
        <section className="block">
          <div className="sec-title">薄弱板块</div>
          {stats.weak_sections.length === 0 ? (
            <div className="row">暂无数据</div>
          ) : (
            <div style={{ width: "100%", height: Math.max(120, stats.weak_sections.length * 36) }}>
              <ResponsiveContainer>
                <BarChart
                  data={stats.weak_sections}
                  layout="vertical"
                  margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="section" tick={{ fontSize: 11 }} width={150} />
                  <Tooltip formatter={(v) => [`${v} 次`, "错题数"]} />
                  <Bar dataKey="count" fill="var(--accent)" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* 能力报告（V0.15.0）：历次报告列表 + 生成入口 */}
        <section className="block">
          <div className="sec-title-row">
            <div className="sec-title">能力报告</div>
            <button className="btn primary" onClick={() => setReportOpen(true)}>
              生成能力报告
            </button>
          </div>
          {!reports || reports.length === 0 ? (
            <div className="row">暂无报告</div>
          ) : (
            reports.map((r) => {
              const vals = Object.values(r.scores || {});
              const avg = vals.length
                ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)
                : null;
              return (
                <Link
                  className="row"
                  key={r.id}
                  to={`/classes/${classInfo.id}/students/${studentId}/reports/${r.id}`}
                >
                  <span className="row-name">
                    {fmtTime(r.created_at)}
                    <span>
                      {rangeLabel(r)} · {r.assignment_count} 次作业
                    </span>
                  </span>
                  {avg !== null && <span className="mono">六维均值 {avg}</span>}
                </Link>
              );
            })
          )}
        </section>

        {/* 历次作业明细 */}
        <section className="block">
          <div className="sec-title">历次作业</div>
          {stats.history.length === 0 && <div className="row">暂无数据</div>}
          {[...stats.history].reverse().map((h) => (
            <Link className="row" key={h.assignment_id} to={`/assignments/${h.assignment_slug || h.assignment_id}`}>
              <span className="row-name">
                {h.unit_label}
                <span>第 {h.lesson_no} 次课{h.class_time ? ` · ${h.class_time}` : ""}</span>
              </span>
              <span className="mono">{h.error_count} 题错</span>
              <span className="mono">{h.status}</span>
              <span className={`mono ${h.score !== null ? scoreTone(h.score) : ""}`} title={isGpa ? `原分数 ${fmtScore(h.score)}` : undefined}>
                {isGpa ? fmtGpa(h.gpa) : fmtScore(h.score)}
                {h.rating ? ` · ${h.rating}` : ""}
              </span>
            </Link>
          ))}
        </section>
      </div>

      <AbilityReportModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        studentId={studentId}
        onSaved={(saved) =>
          navigate(`/classes/${classInfo.id}/students/${studentId}/reports/${saved.id}`)
        }
      />
    </div>
  );
}
