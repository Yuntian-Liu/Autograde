import { IconChevronLeft } from "../components/icons";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api";
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import RadarChart from "../components/RadarChart";
import { fmtTime, seriesLabel } from "../meta";
import { ABILITY_DIMS, rangeLabel } from "../utils/ability";

// 能力分析报告页：雷达 hero + 总评 + 六维细析（子标签/分析/证据引用块）+ 教学建议
export default function ReportDetail() {
  const { classId, studentId, reportId } = useParams();
  const [report, setReport] = useState(null);
  const [reports, setReports] = useState(null);
  const [classInfo, setClassInfo] = useState(null);
  const [error, setError] = useState(null);
  const [compare, setCompare] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet(`/students/${studentId}/ability-reports/${reportId}`),
      apiGet(`/students/${studentId}/ability-reports`),
      apiGet(`/classes/${classId}`),
    ])
      .then(([r, list, c]) => {
        setReport(r);
        setReports(list);
        setClassInfo(c);
      })
      .catch((e) => setError(e.message));
  }, [classId, studentId, reportId]);

  // 上一份报告 = 列表（倒序）中本报告的下一项
  const prevReport = useMemo(() => {
    if (!reports || !report) return null;
    const idx = reports.findIndex((r) => r.id === report.id);
    return idx >= 0 && idx + 1 < reports.length ? reports[idx + 1] : null;
  }, [reports, report]);

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!report || !classInfo || !reports)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const student = (classInfo.students || []).find((s) => s.id === Number(studentId));
  const studentName = student?.name || "";
  const dims = ABILITY_DIMS.map((d) => ({
    ...d,
    score: report.scores?.[d.key] ?? 0,
  }));
  const prevScores = compare && prevReport ? prevReport.scores : null;
  const dimByKey = Object.fromEntries((report.dimensions || []).map((d) => [d.key, d]));

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          { label: `${seriesLabel(classInfo.series)} ${classInfo.name}`, to: `/classes/${classInfo.id}` },
          { label: studentName, to: `/classes/${classInfo.id}/students/${studentId}` },
          { label: "能力报告" },
        ]}
      />
      <div className="wrap wrap-narrow">
        <Link className="back" to={`/classes/${classInfo.id}/students/${studentId}`}>
          <IconChevronLeft />返回学生
        </Link>

        <div className="report-head">
          <h1>能力分析报告</h1>
          <div className="report-meta">
            <span className="report-meta-name">{studentName}</span>
            <span>{rangeLabel(report)}</span>
            <span>{report.assignment_count} 次作业</span>
            <span>生成于 {fmtTime(report.created_at)}</span>
            {report.prompt_tokens > 0 && (
              <span>
                消耗 {(report.prompt_tokens + report.completion_tokens).toLocaleString()} tokens
              </span>
            )}
            {report.elapsed_seconds > 0 && (
              <span>用时 {Math.floor(report.elapsed_seconds / 60)} 分 {report.elapsed_seconds % 60} 秒</span>
            )}
            {report.cost_yuan > 0 && (
              <span className="report-cost">
                成本 ¥{Number(report.cost_yuan).toFixed(4)}（{report.price_tier === "offpeak" ? "谷" : report.price_tier === "peak" ? "峰" : "—"}）
              </span>
            )}
          </div>
        </div>

        {/* 雷达 hero */}
        <section className="block report-hero">
          <div className="sec-title-row">
            <div className="sec-title">能力雷达</div>
            {prevReport && (
              <label className="report-compare">
                <input
                  type="checkbox"
                  checked={compare}
                  onChange={(e) => setCompare(e.target.checked)}
                />
                对比上一份（{fmtTime(prevReport.created_at)}）
              </label>
            )}
          </div>
          <RadarChart dims={dims} prev={prevScores} size={440} />
          {prevReport && compare && (
            <div className="report-legend">
              <span className="report-legend-item">
                <i className="report-legend-swatch cur" />本次
              </span>
              <span className="report-legend-item">
                <i className="report-legend-swatch prev" />上一份
              </span>
            </div>
          )}
        </section>

        {/* 总评 */}
        <section className="block">
          <div className="sec-title">总评</div>
          <p className="report-para">{report.overall}</p>
        </section>

        {/* 六维细析 */}
        <section className="block">
          <div className="sec-title">维度细析</div>
          <div className="report-dims">
            {ABILITY_DIMS.map((meta) => {
              const d = dimByKey[meta.key];
              const score = report.scores?.[meta.key];
              const prev = prevReport?.scores?.[meta.key];
              const delta = compare && prev != null && score != null ? score - prev : null;
              return (
                <div className="report-dim" key={meta.key}>
                  <div className="report-dim-head">
                    <div className="report-dim-name">{meta.label}</div>
                    <div className="report-dim-score">
                      {score != null ? Number(score).toFixed(2) : "—"}
                      {delta !== null && Math.abs(delta) >= 0.005 && (
                        <span className={`radar-delta ${delta > 0 ? "up" : "down"}`}>
                          {delta > 0 ? "↑" : "↓"}
                          {Math.abs(delta).toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                  {d?.tags?.length > 0 && (
                    <div className="report-tags">
                      {d.tags.map((t) => (
                        <span className="report-tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="report-para">{d?.analysis || ""}</p>
                  {d?.evidence?.length > 0 && (
                    <div className="report-evs">
                      {d.evidence.map((ev, i) => (
                        <blockquote className="report-ev" key={i}>
                          <div className="report-ev-quote">{ev.quote}</div>
                          <div className="report-ev-src">{ev.source}</div>
                        </blockquote>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* 教学建议 */}
        <section className="block">
          <div className="sec-title">教学建议</div>
          <p className="report-para">{report.suggestions}</p>
        </section>
      </div>
    </div>
  );
}
