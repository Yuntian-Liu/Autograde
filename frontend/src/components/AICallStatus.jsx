const STAGE_LABELS = {
  preparing: "正在准备材料",
  connecting: "正在连接模型",
  connected: "已连接，等待模型响应",
  thinking: "模型已响应，正在思考",
  searching: "正在网络搜索",
  receiving: "正在接收结果",
  validating: "正在校验结果",
  saving: "正在保存",
  done: "已完成",
};

export default function AICallStatus({ progress, elapsed = 0, showDoneCount = false, compact = false }) {
  if (!progress) return null;
  const failed = progress.status === "error";
  const stage = failed ? progress.error_stage || progress.stage : progress.stage;
  const seconds = progress.elapsed_seconds ?? elapsed;
  return (
    <div className={`ai-call-status${failed ? " error" : ""}${compact ? " compact" : ""}`} role="status" aria-live="polite">
      <div className="ai-call-main">
        <span className="ai-call-dot" />
        <strong>{failed ? "调用失败" : STAGE_LABELS[stage] || "正在调用 AI"}</strong>
        <span>{seconds} 秒</span>
      </div>
      <div className="ai-call-metrics">
        {progress.model && <span>{progress.model}</span>}
        {showDoneCount && <span>已整理 {progress.done_count || 0} 题</span>}
        <span>已接收 {(progress.recv_chars || 0).toLocaleString()} 字符</span>
      </div>
      {failed && (
        <div className="ai-call-error">
          {progress.error || "AI 调用失败"}
          {stage && <span> · {STAGE_LABELS[stage] || stage}</span>}
        </div>
      )}
      {(progress.job_id || progress.provider_request_id) && (
        <details className="ai-call-ids">
          <summary>技术标识</summary>
          {progress.job_id && <span>任务 ID：{progress.job_id}</span>}
          {progress.provider_request_id && <span>模型 Request ID：{progress.provider_request_id}</span>}
        </details>
      )}
    </div>
  );
}
