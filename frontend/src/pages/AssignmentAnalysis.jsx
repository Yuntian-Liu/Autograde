import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { App as AntApp, Popover, Tabs } from "antd";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiGet, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import MdContent from "../components/MdContent";
import PageSkeleton from "../components/PageSkeleton";
import { IconChevronLeft } from "../components/icons";
import { fmtScore, fmtTime, seriesLabel } from "../meta";
import { clientLog } from "../utils/clientLog";

const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" };
const NICE_STEPS = [1, 2, 5, 10, 20, 25, 50, 100];

function Metric({ label, value, tone = "" }) {
  return (
    <div className="metric-card">
      <div className="k">{label}</div>
      <div className={`v ${tone}`}>{value}</div>
    </div>
  );
}

function formatEdge(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function buildScoreDistribution(scores) {
  const values = scores
    .filter((score) => score !== null && score !== "" && Number.isFinite(Number(score)))
    .map(Number);
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  let chosen = null;
  for (const step of NICE_STEPS) {
    let start = Math.floor(min / step) * step;
    let end = Math.ceil(max / step) * step;
    if (end <= start) {
      if (start >= 100 && max <= 100) start -= step;
      else end += step;
    }
    const count = Math.round((end - start) / step);
    chosen = { step, start, end, count };
    if (count <= 8) break;
  }

  let { step, start, end, count } = chosen;
  while (count < 4) {
    const canGoDown = start > 0;
    const canGoUp = max > 100 || end < 100;
    if (!canGoDown && !canGoUp) break;
    if (canGoDown && (!canGoUp || min - start <= end - max)) start -= step;
    else end += step;
    count += 1;
  }

  const bins = Array.from({ length: count }, (_, index) => {
    const from = start + index * step;
    const to = from + step;
    return {
      from,
      to,
      label: `${formatEdge(from)}–${formatEdge(to)}`,
      range: `${formatEdge(from)}–${formatEdge(to)} 分`,
      count: 0,
    };
  });
  for (const score of values) {
    const index = Math.max(0, Math.min(bins.length - 1, Math.floor((score - start) / step)));
    bins[index].count += 1;
  }
  return bins;
}

function gradingPath(assignmentId, studentId) {
  return `/grading/${assignmentId}?student=${studentId}`;
}

function ScoreRanking({ rows, assignmentId }) {
  const ranked = (rows || [])
    .filter((row) => row.status !== "待批改")
    .sort((a, b) => Number(a.status === "未交") - Number(b.status === "未交"));
  const podiumRows = ranked.filter((row) => row.status !== "未交").slice(0, 3);
  const podiumIds = new Set(podiumRows.map((row) => row.student_id));
  const listRows = ranked.filter((row) => !podiumIds.has(row.student_id));
  const maxScore = Math.max(
    0,
    ...podiumRows.concat(listRows).filter((row) => row.status !== "未交").map((row) => Number(row.rank_score ?? row.score ?? 0))
  );
  const podiumCols = [2, 1, 3].map((rank) => ({ rank, player: podiumRows[rank - 1] || null }));

  if (ranked.length === 0) return <div className="row">暂无排名数据</div>;
  return (
    <>
      {podiumRows.length > 0 && (
        <div className="lb-podium">
          {podiumCols.map(({ rank, player }) => (
            <div key={rank} className={`lb-step lb-s${rank}${player ? "" : " empty"}`}>
              <div className="lb-players">
                {player && (
                  <Link className="lb-player" to={gradingPath(assignmentId, player.student_id)}>
                    <span className="lb-medal-emoji">{MEDAL[rank]}</span>
                    <span className="lb-name">{player.name}</span>
                    <span className="lb-score">{fmtScore(player.score)}</span>
                    <span className="lb-sub">{player.status === "缺作业" ? "缺项 · 已批改" : "已批改"}</span>
                  </Link>
                )}
              </div>
              <div className="lb-base">
                <span className="lb-basenum">{rank}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {listRows.map((row) => {
        const absent = row.status === "未交";
        const barScore = absent ? 0 : Math.max(0, Number(row.rank_score ?? row.score ?? 0));
        return (
          <Link className="lb-row analysis-lb-row" key={row.student_id} to={gradingPath(assignmentId, row.student_id)}>
            <span className="lb-rank">{row.rank ?? "—"}</span>
            <span className="lb-rowname">{row.name}</span>
            <span className="lb-bar">
              <span className="lb-fill" style={{ width: `${maxScore > 0 ? (barScore / maxScore) * 100 : 0}%` }} />
            </span>
            <span className="lb-rowscore">{absent ? fmtScore(row.score ?? 0) : fmtScore(row.score)}</span>
            <span className={`lb-rowsub ${absent ? "tone-bad" : ""}`}>
              {absent ? "未交" : row.status === "缺作业" ? "缺项" : "已批改"}
            </span>
          </Link>
        );
      })}
    </>
  );
}

function ScoreDistribution({ scores }) {
  const bins = buildScoreDistribution(scores || []);
  if (bins.length === 0) return <div className="row">暂无有效成绩</div>;
  return (
    <div className="analysis-chart">
      <ResponsiveContainer>
        <ComposedChart data={bins}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
          <XAxis dataKey="label" tick={{ fontSize: "var(--t-micro)", fill: "var(--ink-2)" }} />
          <YAxis allowDecimals={false} tick={{ fontSize: "var(--t-micro)", fill: "var(--ink-2)" }} width={36} />
          <Tooltip
            formatter={(value) => [`${value} 人`, "人数"]}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.range || ""}
          />
          <Bar dataKey="count" fill="var(--accent-bg)" stroke="var(--accent)" />
          <Line
            type="monotone"
            dataKey="count"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--surface)", stroke: "var(--accent)" }}
            tooltipType="none"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function SectionRateChart({ sections }) {
  const rows = (sections || []).map((section) => {
    const rated = (section.questions || []).filter(
      (q) => q.correct_rate !== null && q.correct_rate !== undefined
    );
    if (!rated.length) return null;
    const rate = rated.reduce((sum, q) => sum + Number(q.correct_rate), 0) / rated.length;
    return { name: section.section, rate: Number(rate.toFixed(2)) };
  }).filter(Boolean);
  if (!rows.length) return null;
  return (
    <div className="analysis-rate-chart">
      <div className="sec-title">板块正确率</div>
      <ResponsiveContainer width="100%" height={Math.max(130, rows.length * 48)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 48, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fontSize: "var(--t-micro)", fill: "var(--ink-2)" }} />
          <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: "var(--t-micro)", fill: "var(--ink-2)" }} />
          <Tooltip formatter={(value) => [`${Number(value).toFixed(2)}%`, "正确率"]} />
          <Bar dataKey="rate">
            {rows.map((row) => (
              <Cell
                key={row.name}
                fill={row.rate >= 75 ? "var(--success)" : row.rate >= 60 ? "var(--warning)" : "var(--danger)"}
              />
            ))}
            <LabelList dataKey="rate" position="right" formatter={(value) => `${Number(value).toFixed(2)}%`} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function QuestionStatistics({ sections, assignmentId }) {
  if (!sections || sections.length === 0) return <div className="row">题库待录入</div>;
  return sections.map((section) => (
    <div className="sec-card analysis-section" key={section.section}>
      <div className="analysis-section-head">
        <span className="row-name">{section.section}</span>
        <span className="mono">{section.question_count} 题 · 权重 {section.total_weight}</span>
      </div>
      {(section.questions || []).map((question) => {
        const empty = question.correct_rate === null || question.correct_rate === undefined;
        const tone = empty ? "" : question.correct_rate >= 75 ? "tone-good" : question.correct_rate >= 60 ? "tone-mid" : "tone-bad";
        const wrongStudents = question.wrong_students || [];
        return (
          <div className="analysis-question" key={question.id}>
            <span className="qcard-seq">{question.seq}</span>
            <span className="analysis-question-stem" title={question.stem || `第 ${question.seq} 题`}>
              {question.stem || `第 ${question.seq} 题`}
            </span>
            <span className="rate-wrap">
              <span className="rate-lab">正确率</span>
              <span className={`rate-cap ${tone}`}>{empty ? "—" : `${Number(question.correct_rate).toFixed(2)}%`}</span>
            </span>
            {wrongStudents.length > 0 ? (
              <Popover
                trigger="click"
                title="答错名单"
                content={
                  <div className="rate-pop">
                    {wrongStudents.map((student) => (
                      <Link
                        className="rate-pop-link"
                        key={student.id}
                        to={gradingPath(assignmentId, student.id)}
                      >
                        {student.name}
                      </Link>
                    ))}
                  </div>
                }
              >
                <button type="button" className="btn sm">答错 {wrongStudents.length} 人</button>
              </Popover>
            ) : (
              <span className="analysis-wrong-empty">答错 0 人</span>
            )}
          </div>
        );
      })}
    </div>
  ));
}

function Overview({ data, assignmentId }) {
  const { summary, ranking, valid_scores: validScores, sections } = data;
  const hasValidScores = validScores.length > 0;
  const score = (value) => (hasValidScores ? fmtScore(value) : "—");
  return (
    <>
      <div className="metric-grid analysis-metrics">
        <Metric label="有效成绩人数" value={summary.valid_count} tone="tone-accent" />
        <Metric label="未交" value={summary.absent_count} tone={summary.absent_count > 0 ? "tone-bad" : ""} />
        <Metric label="待批改" value={summary.pending_count} tone={summary.pending_count > 0 ? "tone-mid" : ""} />
        <Metric label="平均分" value={score(summary.avg_score)} />
        <Metric label="中位数" value={score(summary.median_score)} />
        <Metric label="最高分" value={score(summary.max_score)} />
        <Metric label="最低分" value={score(summary.min_score)} />
      </div>
      <section className="block">
        <div className="sec-title">学生排名</div>
        <ScoreRanking rows={ranking} assignmentId={assignmentId} />
      </section>
      <section className="block">
        <div className="sec-title">成绩分布</div>
        <ScoreDistribution scores={validScores} />
      </section>
      <section className="block">
        <div className="sec-title">题目统计</div>
        <QuestionStatistics sections={sections} assignmentId={assignmentId} />
      </section>
    </>
  );
}

function tierLabel(tier, price = false) {
  if (tier === "peak") return price ? "峰时价" : "峰时";
  if (tier === "offpeak") return price ? "谷时价" : "谷时";
  return "未标注";
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined) return "—";
  const seconds = Number(ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)} 分 ${rounded % 60} 秒`;
}

function formatEstimateSeconds(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `约 ${value} 秒`;
  return `约 ${Math.floor(value / 60)} 分 ${value % 60} 秒`;
}

function AiAnalysis({ assignmentId, initialReport, hasValidData, sections }) {
  const { message } = AntApp.useApp();
  const [report, setReport] = useState(initialReport || null);
  const [estimate, setEstimate] = useState(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimateError, setEstimateError] = useState("");
  const [estimateRetry, setEstimateRetry] = useState(0);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recvChars, setRecvChars] = useState(0);
  const runRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (report || estimate || running) return undefined;
    let cancelled = false;
    setEstimateLoading(true);
    setEstimateError("");
    apiPost("/ai/batch-analysis/estimate", { assignment_id: Number(assignmentId) })
      .then((result) => {
        if (!cancelled) setEstimate(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setEstimateError(error.message);
          clientLog.add("ui", `batch_ai_estimate_error assignment=${assignmentId} ${error.message}`.slice(0, 200));
        }
      })
      .finally(() => {
        if (!cancelled) setEstimateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assignmentId, estimate, estimateRetry, report, running]);

  useEffect(
    () => () => {
      runRef.current += 1;
      clearInterval(timerRef.current);
    },
    []
  );

  async function startAnalysis() {
    if (!hasValidData || running) return;
    const run = ++runRef.current;
    const started = Date.now();
    clientLog.add("ui", `batch_ai_start assignment=${assignmentId}`);
    clearInterval(timerRef.current);
    const timer = setInterval(() => {
      if (runRef.current === run) setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    timerRef.current = timer;
    setRunning(true);
    setElapsed(0);
    setRecvChars(0);
    try {
      const { job_id: jobId } = await apiPost("/ai/batch-analysis", {
        assignment_id: Number(assignmentId),
      });
      if (runRef.current !== run) return;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (runRef.current !== run) return;
        const job = await apiGet(`/ai/batch-analysis-jobs/${jobId}`);
        if (runRef.current !== run) return;
        if (job.recv_chars !== null && job.recv_chars !== undefined) setRecvChars(job.recv_chars);
        if (job.status === "done") {
          if (!job.result) throw new Error("分析任务未返回报告");
          setReport(job.result);
          clientLog.add(
            "ui",
            `batch_ai_done assignment=${assignmentId} tokens=${(job.result.prompt_tokens || 0) + (job.result.completion_tokens || 0)} ms=${job.result.total_ms || 0}`
          );
          message.success("批次分析已更新");
          break;
        }
        if (job.status === "error") throw new Error(job.error || "分析失败");
      }
    } catch (error) {
      if (runRef.current === run) {
        clientLog.add("ui", `batch_ai_error assignment=${assignmentId} ${error.message}`.slice(0, 200));
        message.error(error.message);
      }
    } finally {
      clearInterval(timer);
      if (timerRef.current === timer) timerRef.current = null;
      if (runRef.current === run) setRunning(false);
    }
  }

  const totalActualTokens = (report?.prompt_tokens || 0) + (report?.completion_tokens || 0);
  return (
    <section className="block analysis-ai">
      {running ? (
        <div className="report-est">
          <div className="report-est-row">
            <span className="report-est-k">任务状态</span>
            <span className="tone-accent">分析中</span>
          </div>
          <div className="report-est-row">
            <span className="report-est-k">已用时长</span>
            <span>{elapsed} 秒</span>
          </div>
          <div className="report-est-row">
            <span className="report-est-k">已接收</span>
            <span>{recvChars.toLocaleString()} 字符</span>
          </div>
        </div>
      ) : report ? (
        <>
          <div className="sec-title-row analysis-report-head">
            <div className="sec-title">批次分析报告</div>
            <button className="btn" onClick={startAnalysis} disabled={!hasValidData}>重新分析</button>
          </div>
          <div className="report-est analysis-actual">
            <div className="report-est-row">
              <span className="report-est-k">实耗 tokens</span>
              <span>
                输入 {(report.prompt_tokens || 0).toLocaleString()} + 输出 {(report.completion_tokens || 0).toLocaleString()}（合计 {totalActualTokens.toLocaleString()}）
              </span>
            </div>
            <div className="report-est-row">
              <span className="report-est-k">实际用时</span>
              <span>{formatDurationMs(report.total_ms)}</span>
            </div>
            <div className="report-est-row">
              <span className="report-est-k">实际成本</span>
              <span>¥{Number(report.cost_yuan || 0).toFixed(4)}（{tierLabel(report.price_tier)}）</span>
            </div>
            {(report.model || report.updated_at || report.created_at) && (
              <div className="report-est-row">
                <span className="report-est-k">生成信息</span>
                <span>
                  {report.model || "—"}
                  {(report.updated_at || report.created_at) && ` · ${fmtTime(report.updated_at || report.created_at)}`}
                </span>
              </div>
            )}
          </div>
          <div className="analysis-report-content">
            <SectionRateChart sections={sections} />
            <MdContent text={report.content || ""} />
          </div>
        </>
      ) : (
        <>
          <div className="sec-title">分析预估</div>
          {estimateLoading ? (
            <div className="row">预估中…</div>
          ) : estimate ? (
            <div className="report-est">
              <div className="report-est-row">
                <span className="report-est-k">数据量</span>
                <span>{Number(estimate.chars || 0).toLocaleString()} 字符</span>
              </div>
              <div className="report-est-row">
                <span className="report-est-k">预估消耗</span>
                <span>
                  输入约 {Number(estimate.est_prompt_tokens || 0).toLocaleString()} + 输出约 {Number(estimate.est_output_tokens || 0).toLocaleString()}（合计约 {Number(estimate.est_total_tokens || 0).toLocaleString()} tokens）
                </span>
              </div>
              <div className="report-est-row">
                <span className="report-est-k">预估费用</span>
                <span>¥{Number(estimate.est_cost_yuan || 0).toFixed(4)}（{tierLabel(estimate.price_tier, true)}）</span>
              </div>
              <div className="report-est-row">
                <span className="report-est-k">预估时长</span>
                <span>{formatEstimateSeconds(estimate.est_seconds)}</span>
              </div>
            </div>
          ) : (
            <div className="report-est">
              <div className="report-est-row report-est-warn">{estimateError || "预估失败"}</div>
              <button
                className="btn sm analysis-estimate-retry"
                onClick={() => {
                  setEstimate(null);
                  setEstimateRetry((value) => value + 1);
                }}
              >
                重新预估
              </button>
            </div>
          )}
        </>
      )}
      {!hasValidData && !report && !running && (
        <div className="analysis-no-data">暂无有效成绩，无法开始分析</div>
      )}
      {!report && (
        <div className="report-gen-actions">
          <button className="btn primary" onClick={startAnalysis} disabled={!hasValidData || running || estimateLoading}>
            {running ? "分析中…" : "开始分析"}
          </button>
        </div>
      )}
    </section>
  );
}

export default function AssignmentAnalysis() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    apiGet(`/assignments/${id}/analysis`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );
  }

  const assignment = data.assignment;
  const classInfo = assignment.class;
  const isTemp = Boolean(classInfo?.is_temp);
  const assignmentRef = assignment.slug || assignment.id;
  const assignmentLabel = `${assignment.unit_label} ${assignment.content}`.trim();
  const assignmentTitle = `${isTemp && classInfo?.name ? `${classInfo.name} · ` : ""}${assignmentLabel}`;
  const backPath = isTemp ? "/temp" : classInfo ? `/classes/${classInfo.id}` : "/";
  const backLabel = isTemp ? "临时批改" : classInfo ? `${seriesLabel(classInfo.series)} ${classInfo.name}` : "工作台";
  const hasValidData = data.valid_scores.length > 0;

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          ...(isTemp
            ? [{ label: "临时批改", to: "/temp" }]
            : classInfo
              ? [{ label: `${seriesLabel(classInfo.series)} ${classInfo.name}`, to: `/classes/${classInfo.id}` }]
              : []),
          { label: assignmentLabel, to: `/assignments/${assignmentRef}` },
          { label: "批次分析" },
        ]}
      />
      <div className="wrap wrap-wide">
        <Link className="back" to={backPath}><IconChevronLeft />{backLabel}</Link>
        <h1 className="analysis-title">{assignmentTitle} · 批次分析</h1>
        <Tabs
          key={id}
          className="analysis-tabs"
          defaultActiveKey="overview"
          items={[
            {
              key: "overview",
              label: "数据总览",
              children: <Overview data={data} assignmentId={assignmentRef} />,
            },
            {
              key: "ai",
              label: "AI 分析",
              children: (
                <AiAnalysis
                  key={assignment.id}
                  assignmentId={assignment.id}
                  initialReport={data.ai_report}
                  hasValidData={hasValidData}
                  sections={data.sections}
                />
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
