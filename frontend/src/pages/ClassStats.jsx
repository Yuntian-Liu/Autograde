import { IconChevronLeft } from "../components/icons";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
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
import { seriesLabel } from "../meta";

// 班级统计页：历次平均分趋势 + 提交率堆叠条 + 每题错误排行
export default function ClassStats() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiGet(`/classes/${id}/stats`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!data)
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

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          { label: `${seriesLabel(c.series)} ${c.name}`, to: `/classes/${c.id}` },
          { label: "班级统计" },
        ]}
      />
      <div className="wrap">
        <Link className="back" to={`/classes/${c.id}`}>
          <IconChevronLeft />返回班级
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>{c.name} · 班级统计</h1>

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
