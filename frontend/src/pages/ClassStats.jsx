import { IconChevronLeft } from "../components/icons";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Segmented, Select } from "antd";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import { fmtScore, seriesLabel } from "../meta";
import { batchStatus, computeLeaderboard } from "../utils/leaderboard";

// 班级统计页：排行榜 + 历次平均分趋势 + 提交率堆叠条 + 每题错误排行
export default function ClassStats() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [lb, setLb] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState("live"); // live 实时 / hist 历次
  const [upto, setUpto] = useState(null); // 历次：截至第 N 次（已完成批次序号）
  const [weighted, setWeighted] = useState(true); // 历次：含提交率 / 纯分数

  useEffect(() => {
    Promise.all([apiGet(`/classes/${id}/stats`), apiGet(`/classes/${id}/leaderboard`)])
      .then(([s, l]) => {
        setData(s);
        setLb(l);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!data || !lb)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const c = data.class;
  const trend = data.assignments.map((a) => ({
    label: a.unit_label,
    avg: a.avg_score,
    submitted: a.submitted,
    total: a.total_students,
  }));
  const submitData = data.assignments.map((a) => ({
    label: a.unit_label,
    已交: a.submitted,
    未交: a.absent,
    待批改: a.pending,
  }));
  const topErrors = data.top_errors.map((e) => ({
    name: `${e.section} 第${e.seq}题`,
    count: e.count,
  }));

  // 排行榜：实时 = 未开始以外的批次（永远含提交率）；历次 = 已完成批次前 N 个
  const doneBatches = lb.batches.filter((b) => batchStatus(b) === "已完成");
  const effUpto = upto ?? doneBatches.length;
  const lbRows = computeLeaderboard(lb.batches, lb.students, {
    live: mode === "live",
    upto: effUpto,
    weighted,
  });
  const lbEmpty = lbRows.length === 0 || lbRows[0].total === 0;
  const maxScore = lbRows.length ? Math.max(...lbRows.map((r) => r.score)) : 0;
  // 领奖台：金中银左铜右，一名一人（同分按批改先后顺延，见 leaderboard.js）；人不够时留空台阶
  const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const podiumCols = [2, 1, 3].map((rank) => ({
    rank,
    player: lbRows.find((r) => r.rank === rank) || null,
  }));

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          { label: `${seriesLabel(c.series)} ${c.name}`, to: `/classes/${c.id}` },
          { label: "班级统计" },
        ]}
      />
      <div className="wrap wrap-wide">
        <Link className="back" to={`/classes/${c.id}`}>
          <IconChevronLeft />返回班级
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>{c.name} · 班级统计</h1>

        {/* 排行榜 */}
        <section className="block">
          <div className="sec-title">排行榜</div>
          <div className="lb-controls">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { label: "实时排名", value: "live" },
                { label: "历次排名", value: "hist" },
              ]}
            />
            {mode === "hist" && (
              <>
                <Select
                  value={effUpto || null}
                  onChange={setUpto}
                  style={{ width: 180 }}
                  options={doneBatches.map((b, i) => ({
                    value: i + 1,
                    label: `第 ${i + 1} 次 · ${b.unit_label}`,
                  }))}
                />
                <Segmented
                  value={weighted ? "w" : "p"}
                  onChange={(v) => setWeighted(v === "w")}
                  options={[
                    { label: "含提交率", value: "w" },
                    { label: "纯分数", value: "p" },
                  ]}
                />
              </>
            )}
          </div>
          {lbEmpty ? (
            <div className="row">暂无已批改的批次</div>
          ) : (
            <>
              {/* 领奖台：金中银左铜右，台阶高度固定递减；一名一人，人不够留空台阶 */}
              <div className="lb-podium">
                {podiumCols.map(({ rank, player }) => (
                  <div key={rank} className={`lb-step lb-s${rank}${player ? "" : " empty"}`}>
                    <div className="lb-players">
                      {player && (
                        <Link
                          className="lb-player"
                          to={`/classes/${id}/students/${player.student_id}`}
                        >
                          <span className="lb-medal-emoji">{MEDAL[rank]}</span>
                          <span className="lb-name">{player.name}</span>
                          <span className="lb-score">{player.score.toFixed(2)}</span>
                          <span className="lb-sub">
                            均分 {fmtScore(player.avg)} · 交 {player.submitted}/{player.total}
                          </span>
                        </Link>
                      )}
                    </div>
                    <div className="lb-base">
                      <span className="lb-basenum">{rank}</span>
                    </div>
                  </div>
                ))}
              </div>
              {/* 第 4 名起：横条行 */}
              {lbRows.filter((r) => r.rank > 3).map((r) => (
                <Link
                  className="lb-row"
                  key={r.student_id}
                  to={`/classes/${id}/students/${r.student_id}`}
                >
                  <span className="lb-rank">{r.rank}</span>
                  <span className="lb-rowname">{r.name}</span>
                  <span className="lb-bar">
                    <span
                      className="lb-fill"
                      style={{ width: `${maxScore > 0 ? (r.score / maxScore) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="lb-rowscore">{r.score.toFixed(2)}</span>
                  <span className="lb-rowsub">
                    均分 {fmtScore(r.avg)} · 交 {r.submitted}/{r.total}
                  </span>
                </Link>
              ))}
            </>
          )}
        </section>

        {/* 历次平均分趋势 */}
        <section className="block">
          <div className="sec-title">历次平均分</div>
          {trend.length === 0 ? (
            <div className="row">暂无数据</div>
          ) : (
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={36} />
                  <Tooltip
                    formatter={(v, name, item) =>
                      name === "平均分"
                        ? [`${Number(v).toFixed(2)}（${item.payload.submitted}/${item.payload.total} 人）`, name]
                        : [v, name]
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="avg"
                    name="平均分"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    connectNulls={false}
                    dot={{ r: 4, fill: "var(--accent)", strokeWidth: 0 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* 提交率（堆叠条） */}
        <section className="block">
          <div className="sec-title">提交情况</div>
          {submitData.length === 0 ? (
            <div className="row">暂无数据</div>
          ) : (
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={submitData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="已交" stackId="s" fill="var(--success)" />
                  <Bar dataKey="未交" stackId="s" fill="var(--danger)" />
                  <Bar dataKey="待批改" stackId="s" fill="var(--ink-3)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* 每题错误排行 */}
        <section className="block">
          <div className="sec-title">每题错误排行</div>
          {topErrors.length === 0 ? (
            <div className="row">暂无数据</div>
          ) : (
            <div style={{ width: "100%", height: Math.max(160, topErrors.length * 32) }}>
              <ResponsiveContainer>
                <BarChart data={topErrors} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={180} />
                  <Tooltip formatter={(v) => [`${v} 人答错`, "错误次数"]} />
                  <Bar dataKey="count" fill="var(--warning)" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
