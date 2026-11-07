import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { App as AntApp, Modal, Select, Tabs } from "antd";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiGet, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import MdContent from "../components/MdContent";
import PageSkeleton from "../components/PageSkeleton";
import { IconChevronLeft, IconDownload } from "../components/icons";
import { fmtScore, fmtTime } from "../meta";
import { clientLog } from "../utils/clientLog";
import "../weekly.css";

function Metric({ label, value, delta }) {
  return (
    <div className="metric-card">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      <div className="s">{delta}</div>
    </div>
  );
}

function deltaText(now, before, suffix = "") {
  const diff = (now ?? 0) - (before ?? 0);
  return `较上周 ${diff > 0 ? "+" : ""}${Number(diff.toFixed(2))}${suffix}`;
}

function weekShift(start, days) {
  const value = new Date(`${start}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function currentWeekStart() {
  const now = new Date();
  const value = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function Heatmap({ data, onSelect }) {
  const { batches, sections } = data;
  if (!batches.length || !sections.length) return <div className="row">暂无错题热力数据</div>;
  return (
    <div className="heat-scroll">
      <div className="heat-grid" style={{ gridTemplateColumns: `140px repeat(${batches.length}, minmax(140px, 1fr))` }}>
        <div className="heat-head">板块</div>
        {batches.map((batch) => <div className="heat-head" key={batch.assignment_id}>{batch.unit_label}</div>)}
        {sections.map((sectionName) => (
          <div className="heat-row" key={sectionName}>
            <div className="heat-section">{sectionName}</div>
            {batches.map((batch) => {
              const cell = batch.sections.find((item) => item.section === sectionName);
              const rate = cell?.error_rate;
              const tone = rate == null || rate === 0 ? "zero" : rate < 25 ? "low" : rate < 50 ? "mid" : rate < 75 ? "high" : "max";
              return (
                <button
                  className={`heat-cell heat-${tone}`}
                  key={`${sectionName}-${batch.assignment_id}`}
                  onClick={() => cell && onSelect(batch, cell)}
                  disabled={!cell}
                  title={cell ? `错误 ${cell.error_count} 次 · 错误率 ${rate}%` : "无数据"}
                >
                  {cell ? <><strong>{cell.error_count}</strong><span>{rate == null ? "—" : `${rate}%`}</span></> : "—"}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function WeeklyReport() {
  const { message, modal } = AntApp.useApp();
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState(0);
  const [week, setWeek] = useState(null);
  const [tab, setTab] = useState("week");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    apiGet("/classes").then(setClasses).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    const query = new URLSearchParams({ class_id: String(classId) });
    if (week) query.set("week", week);
    apiGet(`/weekly-report?${query}`)
      .then((result) => {
        if (!alive) return;
        setData(result);
        setWeek(result.week.start);
      })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [classId, week]);

  async function generate() {
    setEstimating(true);
    try {
      const estimate = await apiPost("/ai/weekly-report/estimate", { week, class_id: classId });
      clientLog.operation("weekly_ai_estimate", "success", { week, class: classId });
      modal.confirm({
        title: "生成本周 AI 观察",
        centered: true,
        content: `预计 ${estimate.est_total_tokens.toLocaleString()} tokens · ¥${estimate.est_cost_yuan.toFixed(4)} · 约 ${estimate.est_seconds} 秒（${estimate.price_tier === "offpeak" ? "谷时" : "峰时"}）`,
        okText: "开始生成",
        cancelText: "取消",
        onOk: startJob,
      });
    } catch (e) {
      clientLog.operation("weekly_ai_estimate", "error", { week, class: classId, error: e.message });
      message.error(e.message);
    } finally {
      setEstimating(false);
    }
  }

  async function startJob() {
    if (running) return;
    setRunning(true);
    setElapsed(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    try {
      const { job_id: jobId } = await apiPost("/ai/weekly-report", { week, class_id: classId });
      clientLog.operation("weekly_ai_start", "success", { week, class: classId, job: jobId });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const job = await apiGet(`/ai/weekly-report-jobs/${jobId}`);
        if (job.status === "done") {
          setData((prev) => ({ ...prev, ai_report: job.result }));
          clientLog.operation("weekly_ai_done", "success", {
            week,
            class: classId,
            job: jobId,
            tokens: (job.result.prompt_tokens || 0) + (job.result.completion_tokens || 0),
          });
          message.success("本周观察已生成并保存");
          break;
        }
        if (job.status === "error") throw new Error(job.error || "生成失败");
      }
    } catch (e) {
      clientLog.operation("weekly_ai_error", "error", { week, class: classId, error: e.message });
      message.error(e.message);
    } finally {
      clearInterval(timer);
      setRunning(false);
    }
  }

  function printReport() {
    clientLog.operation("weekly_print", "success", { week, class: classId });
    window.print();
  }

  if (error) return <div className="page-enter"><div className="page-error">加载失败：{error}</div></div>;
  if (!data) return <PageSkeleton />;

  const current = data.current;
  const previous = data.previous;
  const report = data.ai_report;
  const statusData = ["已批改", "缺作业", "未交"].map((name) => ({ name, count: current.status_counts[name] || 0 }));

  return (
    <div className="page-enter weekly-page">
      <AppHeader crumbs={[{ label: "工作台", to: "/" }, { label: "助教周报" }]} />
      <div className="wrap wrap-wide">
        <Link className="back no-print" to="/"><IconChevronLeft />返回工作台</Link>
        <div className="weekly-title-row">
          <div>
            <h1>助教周报</h1>
            <div className="weekly-week">{data.week.label} · {data.scope.classes.map((c) => c.name).join("、") || "暂无班级"}</div>
          </div>
          <button className="btn no-print" onClick={printReport}><IconDownload />打印 / 保存 PDF</button>
        </div>

        <div className="weekly-toolbar no-print">
          <Select
            value={classId}
            onChange={setClassId}
            style={{ width: 180 }}
            options={[{ value: 0, label: "全部正式班级" }, ...classes.map((c) => ({ value: c.id, label: c.name }))]}
          />
          {tab === "week" && (
            <div className="weekly-week-controls">
              <button className="btn" onClick={() => setWeek(weekShift(data.week.start, -7))}>上一周</button>
              <button className="btn" onClick={() => setWeek(weekShift(data.week.start, 7))} disabled={data.week.start >= currentWeekStart()}>下一周</button>
            </div>
          )}
        </div>

        <Tabs
          activeKey={tab}
          onChange={(value) => {
            setTab(value);
            clientLog.operation("weekly_tab", "success", { tab: value });
          }}
          items={[{ key: "week", label: "周报" }, { key: "heatmap", label: "错题热力" }]}
        />

        {tab === "week" ? (
          <div className="weekly-print-area">
            <section className="weekly-metrics">
              <Metric label="完成批改" value={`${current.graded_submissions} 份`} delta={deltaText(current.graded_submissions, previous.graded_submissions, " 份")} />
              <Metric label="勾选错题" value={`${current.error_count} 题`} delta={deltaText(current.error_count, previous.error_count, " 题")} />
              <Metric label="定稿解析" value={`${current.finalized_notes} 条`} delta={deltaText(current.finalized_notes, previous.finalized_notes, " 条")} />
              <Metric label="平均分" value={current.avg_score == null ? "—" : fmtScore(current.avg_score)} delta={current.avg_score == null || previous.avg_score == null ? "暂无对比" : deltaText(current.avg_score, previous.avg_score, " 分")} />
              <Metric label="AI 调用" value={`${current.ai_calls} 次`} delta={deltaText(current.ai_calls, previous.ai_calls, " 次")} />
              <Metric label="AI 成本" value={`¥${current.ai_cost_yuan.toFixed(4)}`} delta={deltaText(current.ai_cost_yuan, previous.ai_cost_yuan, " 元")} />
            </section>

            <div className="weekly-chart-grid">
              <section className="block">
                <div className="sec-title">提交情况</div>
                <div className="weekly-chart">
                  <ResponsiveContainer>
                    <BarChart data={statusData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                      <XAxis dataKey="name" tick={{ fontSize: "var(--t-micro)" }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: "var(--t-micro)" }} width={30} />
                      <Tooltip formatter={(value) => [`${value} 份`, "数量"]} />
                      <Bar dataKey="count" fill="var(--accent)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
              <section className="block">
                <div className="sec-title">错误板块</div>
                <div className="weekly-chart">
                  <ResponsiveContainer>
                    <BarChart data={current.top_sections} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: "var(--t-micro)" }} />
                      <YAxis type="category" dataKey="section" width={90} tick={{ fontSize: "var(--t-micro)" }} />
                      <Tooltip formatter={(value) => [`${value} 题`, "错误"]} />
                      <Bar dataKey="count" fill="var(--warning)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </div>

            <section className="block">
              <div className="sec-title">关注名单</div>
              {data.focus.length === 0 ? <div className="row">当前没有符合规则的关注对象</div> : (
                <div className="weekly-focus-list">
                  {data.focus.map((person) => (
                    <Link className="weekly-focus" key={person.student_id} to={`/classes/${person.class_id}/students/${person.student_id}`}>
                      <div className="weekly-focus-name"><strong>{person.name}</strong><span>{person.class_name} · {person.code}</span></div>
                      <div className="weekly-focus-reasons">
                        {person.reasons.map((reason) => <div className="weekly-reason" key={reason.type}><span className="tag-pill lack">{reason.type}</span>{reason.detail}</div>)}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            <section className="block weekly-ai">
              <div className="sec-title-row">
                <div className="sec-title">AI 本周观察</div>
                <button className="btn no-print" onClick={generate} disabled={estimating || running || !current.graded_submissions}>
                  {running ? `生成中 · ${elapsed}s` : estimating ? "预估中…" : report ? "重新生成" : "生成观察"}
                </button>
              </div>
              {report ? (
                <>
                  <div className="weekly-ai-meta">
                    <span>{report.model}</span>
                    <span>输入 {report.prompt_tokens} + 输出 {report.completion_tokens}</span>
                    <span>¥{report.cost_yuan.toFixed(4)}（{report.price_tier === "offpeak" ? "谷时" : report.price_tier ? "峰时" : "—"}）</span>
                    <span>{fmtTime(report.updated_at)}</span>
                  </div>
                  <MdContent text={report.content} />
                </>
              ) : <div className="row">尚未生成本周观察，以上统计无需 AI 即可使用。</div>}
            </section>
          </div>
        ) : (
          <section className="block">
            <div className="sec-title-row"><div className="sec-title">最近 8 批错题热力</div><span className="auto-tag">颜色越深，错误率越高</span></div>
            <Heatmap data={data.heatmap} onSelect={(batch, cell) => {
              setSelected({ batch, cell });
              clientLog.operation("weekly_heatmap_open", "success", { assignment: batch.assignment_id, section: cell.section });
            }} />
          </section>
        )}
      </div>

      <Modal
        centered
        open={Boolean(selected)}
        onCancel={() => setSelected(null)}
        footer={null}
        width={720}
        title={selected ? `${selected.batch.unit_label} · ${selected.cell.section}` : ""}
        destroyOnHidden
      >
        {selected && (
          <div className="weekly-heat-detail">
            <div className="weekly-heat-summary">错误 {selected.cell.error_count} 次 · 错误率 {selected.cell.error_rate}% · 有效批改 {selected.cell.graded_count} 人</div>
            {selected.cell.questions.map((q) => (
              <div className="weekly-question" key={q.id}>
                <span>第 {q.seq} 题</span>
                <span>错 {q.wrong_count} 人 · 正确率 {q.correct_rate == null ? "—" : `${q.correct_rate}%`}</span>
                <span className="weekly-question-names">
                  {q.wrong_students.map((student) => (
                    <Link key={student.id} to={`/grading/${selected.batch.slug || selected.batch.assignment_id}?student=${student.id}`}>{student.name}</Link>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
