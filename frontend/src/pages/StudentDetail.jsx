import { IconChevronLeft } from "../components/icons";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
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
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import { fmtScore, scoreColorVar, scoreTone, seriesLabel } from "../meta";

const GRADED = new Set(["已批改", "缺作业"]);

// 学生详情页：信息头 + 历次成绩趋势 + 薄弱板块 + 明细表
export default function StudentDetail() {
  const { classId, studentId } = useParams();
  const [stats, setStats] = useState(null);
  const [classInfo, setClassInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      apiGet(`/students/${studentId}/stats`),
      apiGet(`/classes/${classId}`),
    ])
      .then(([s, c]) => {
        setStats(s);
        setClassInfo(c);
      })
      .catch((e) => setError(e.message));
  }, [classId, studentId]);

  const scored = useMemo(
    () => (stats?.history || []).filter((h) => GRADED.has(h.status) && h.score !== null),
    [stats]
  );
  const recentAvg5 = scored.length
    ? (scored.slice(-5).reduce((sum, h) => sum + h.score, 0) / Math.min(5, scored.length)).toFixed(2)
    : null;
  const lastScore = scored.length ? scored[scored.length - 1].score : null;

  // 折线数据：未交/待批改的点断开不连（score 置 null，connectNulls=false）
  const trendData = useMemo(
    () =>
      (stats?.history || []).map((h) => ({
        label: h.unit_label,
        score: GRADED.has(h.status) && h.score !== null ? Number(h.score) : null,
        status: h.status,
      })),
    [stats]
  );

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!stats || !classInfo)
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
            {s.note && <div className="stu-meta">{s.note}</div>}
            <div className="stu-stats">
              <div className="stat">
                <div className="k">近 5 次平均</div>
                <div className="v">{fmtScore(recentAvg5)}</div>
              </div>
              <div className="stat">
                <div className="k">上一次</div>
                <div className="v">{fmtScore(lastScore)}</div>
              </div>
              <div className="stat">
                <div className="k">作业次数</div>
                <div className="v">{stats.history.length}</div>
              </div>
            </div>
          </div>
        </div>

        {/* 历次作业趋势 */}
        <section className="block">
          <div className="sec-title">历次成绩趋势</div>
          {trendData.length === 0 ? (
            <div className="row">暂无数据</div>
          ) : (
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={trendData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={36} />
                  <Tooltip
                    formatter={(v, _n, item) => [
                      v === null ? "—" : Number(v).toFixed(2),
                      `分数（${item.payload.status}）`,
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="score"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    connectNulls={false}
                    dot={(props) => {
                      const { cx, cy, payload, index } = props;
                      if (payload.score === null) return <g key={index} />;
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
              <span className={`mono ${h.score !== null ? scoreTone(h.score) : ""}`}>
                {fmtScore(h.score)}
                {h.rating ? ` · ${h.rating}` : ""}
              </span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
