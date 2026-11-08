import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useScoreView } from "../contexts/ScoreViewContext";
import { fmtGpa } from "../gpa";
import { fmtScore } from "../meta";
import MdContent from "./MdContent";

const HEADINGS = ["本周一句话", "数据亮点", "异常与关注", "下周观察点"];

function splitSections(content) {
  const matches = [...content.matchAll(/^## (.+)$/gm)];
  const result = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    result[match[1].trim()] = content.slice(match.index + match[0].length, matches[index + 1]?.index).trim();
  }
  return HEADINGS.every((heading) => result[heading]) ? result : null;
}

function delta(now, before, suffix = "") {
  if (now == null || before == null) return "—";
  const value = Number((now - before).toFixed(2));
  return `${value > 0 ? "+" : ""}${value}${suffix}`;
}

function ComparisonTable({ current, previous }) {
  const { isGpa } = useScoreView();
  const rows = [
    { label: "完成批改", now: current.graded_submissions, before: previous.graded_submissions, suffix: " 份" },
    { label: "勾选错题", now: current.error_count, before: previous.error_count, suffix: " 题" },
    { label: "定稿解析", now: current.finalized_notes, before: previous.finalized_notes, suffix: " 条" },
    { label: isGpa ? "平均 GPA" : "平均分", now: isGpa ? current.avg_gpa : current.avg_score, before: isGpa ? previous.avg_gpa : previous.avg_score, suffix: isGpa ? "" : " 分", score: true, gpa: isGpa },
  ];
  return (
    <div className="weekly-insight-table-wrap">
      <table className="weekly-insight-table">
        <thead><tr><th>指标</th><th>本周</th><th>上周</th><th>变化</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th>{row.label}</th>
              <td>{row.now == null ? "—" : row.gpa ? fmtGpa(row.now) : row.score ? fmtScore(row.now) : `${row.now}${row.suffix}`}</td>
              <td>{row.before == null ? "—" : row.gpa ? fmtGpa(row.before) : row.score ? fmtScore(row.before) : `${row.before}${row.suffix}`}</td>
              <td className={row.now != null && row.before != null && row.now !== row.before ? "changed" : ""}>
                {delta(row.now, row.before, row.suffix)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function WeeklyInsight({ content, current, previous }) {
  const sections = splitSections(content || "");
  if (!sections) return <MdContent text={content} />;
  return (
    <div className="weekly-insight">
      <section className="weekly-insight-summary">
        <div className="weekly-insight-label">本周一句话</div>
        <MdContent text={sections["本周一句话"]} />
      </section>

      <section className="weekly-insight-card weekly-insight-data">
        <h3>数据亮点</h3>
        <div className="weekly-insight-data-grid">
          <div className="weekly-insight-copy"><MdContent text={sections["数据亮点"]} /></div>
          <ComparisonTable current={current} previous={previous} />
        </div>
        {current.top_sections.length > 0 && (
          <div className="weekly-insight-chart" aria-label="高频错误板块条形图">
            <ResponsiveContainer>
              <BarChart data={current.top_sections} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: "var(--t-micro)" }} />
                <YAxis type="category" dataKey="section" width={100} tick={{ fontSize: "var(--t-caption)" }} />
                <Tooltip formatter={(value) => [`${value} 题`, "勾选错题"]} />
                <Bar dataKey="count" fill="var(--warning)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <div className="weekly-insight-columns">
        <section className="weekly-insight-card weekly-insight-attention">
          <h3>异常与关注</h3>
          <MdContent text={sections["异常与关注"]} />
        </section>
        <section className="weekly-insight-card weekly-insight-watch">
          <h3>下周观察点</h3>
          <MdContent text={sections["下周观察点"]} />
        </section>
      </div>
    </div>
  );
}
