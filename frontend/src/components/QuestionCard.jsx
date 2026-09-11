import { modeLabel } from "../meta";

// 题库题目卡片：题号徽章 / 题干 / 选项 / 答案（主题色高亮）/ 解析（默认折叠）
// 题干、选项、答案分离的结构同时为后续「快捷批改」答案表复用
export default function QuestionCard({ question, actions }) {
  const q = question;
  return (
    <div className="qcard">
      <div className="qcard-head">
        <span className="qcard-seq" title={`题目 #${q.id}`}>
          {q.seq}
        </span>
        <span className="qcard-meta">
          {modeLabel(q.mode)} · {q.score_weight} 分
        </span>
        {actions && <span className="qcard-actions">{actions}</span>}
      </div>
      {q.stem && <div className="qcard-stem">{q.stem}</div>}
      {q.options?.length > 0 && (
        <ul className="qcard-options">
          {q.options.map((opt, i) => (
            <li key={i}>{opt}</li>
          ))}
        </ul>
      )}
      <div className="qcard-answer">答案：{q.standard_answer}</div>
      {q.explanation && (
        <details className="qcard-expl">
          <summary>解析</summary>
          <div className="qcard-expl-body">{q.explanation}</div>
        </details>
      )}
    </div>
  );
}
