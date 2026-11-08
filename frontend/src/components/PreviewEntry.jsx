import { useEffect, useRef, useState } from "react";
import { App as AntApp, Input, Modal } from "antd";
import { apiGet, apiPatch, apiPost } from "../api";
import { clientLog } from "../utils/clientLog";
import AICallStatus from "./AICallStatus";

const CHOICES = ["A", "B", "C", "D"];

export default function PreviewEntry({ open, onClose, assignment, onSaved }) {
  const { message } = AntApp.useApp();
  const [answers, setAnswers] = useState(Array(5).fill(""));
  const [explanations, setExplanations] = useState(Array(5).fill(""));
  const [saving, setSaving] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [rawText, setRawText] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const runRef = useRef(0);

  useEffect(() => {
    if (open) {
      const existingAnswers = assignment?.preview_answers || [];
      const existingExplanations = assignment?.preview_explanations || [];
      setAnswers(Array.from({ length: 5 }, (_, i) => existingAnswers[i] || ""));
      setExplanations(Array.from({ length: 5 }, (_, i) => existingExplanations[i] || ""));
      setAiOpen(false);
      setRawText("");
      setRunning(false);
      setProgress(null);
      setElapsed(0);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!running) return undefined;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const complete = answers.every(Boolean);

  function cancel() {
    runRef.current += 1;
    setRunning(false);
    onClose();
  }

  async function parse() {
    if (!rawText.trim()) return message.error("请先粘贴预习答案与解析原文");
    const run = ++runRef.current;
    setRunning(true);
    setElapsed(0);
    setProgress({ stage: "preparing", recv_chars: 0, done_count: 0 });
    clientLog.operation("preview_ai", "start", { assignment: assignment.id, chars: rawText.length });
    try {
      const created = await apiPost("/ai/parse-preview", {
        raw_text: rawText,
        assignment_id: Number(assignment.id),
      });
      const jobId = created.job_id;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (runRef.current !== run) return;
        const job = await apiGet(`/ai/preview-jobs/${jobId}`);
        if (runRef.current !== run) return;
        setProgress(job);
        if (job.status === "done") {
          const questions = job.data?.questions || [];
          if (questions.length !== 5) throw new Error("AI 未返回恰好 5 道预习题，请重新拆分");
          setAnswers(questions.map((q) => q.standard_answer || ""));
          setExplanations(questions.map((q) => q.explanation || ""));
          clientLog.operation("preview_ai", "success", { assignment: assignment.id, job: jobId, questions: 5 });
          message.success("已拆出 5 道预习题，请核对后保存");
          setAiOpen(false);
          break;
        }
        if (job.status === "error") throw new Error(job.error || "预习拆分失败");
      }
    } catch (error) {
      if (runRef.current !== run) return;
      clientLog.operation("preview_ai", "error", { assignment: assignment.id, error: error.message });
      message.error(error.message);
    } finally {
      if (runRef.current === run) setRunning(false);
    }
  }

  async function submit() {
    if (!complete) return;
    setSaving(true);
    try {
      await apiPatch(`/assignments/${assignment.slug || assignment.id}`, {
        preview_answers: answers,
        preview_explanations: explanations,
      });
      clientLog.add("ui", `预习答案解析保存：批次${assignment.id}`);
      message.success("预习答案与解析已保存");
      onSaved();
      onClose();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      centered
      open={open}
      onCancel={cancel}
      onOk={submit}
      confirmLoading={saving}
      okButtonProps={{ disabled: !complete || running }}
      title="预习答案与解析"
      okText="保存"
      cancelText="取消"
      width={760}
      destroyOnHidden
    >
      <div className="preview-entry-toolbar">
        <button type="button" className="btn" onClick={() => setAiOpen((value) => !value)} disabled={running}>
          {aiOpen ? "收起 AI 录入" : "AI 录入"}
        </button>
      </div>
      {aiOpen && (
        <div className="preview-ai-entry">
          <Input.TextArea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            rows={9}
            readOnly={running}
            placeholder="粘贴 5 道预习题的答案与解析原文，AI 只拆分，不改写"
          />
          <div className="modal-actions">
            <button type="button" className="btn primary" onClick={parse} disabled={running}>
              {running ? "正在拆分" : "AI 拆分"}
            </button>
          </div>
          {(running || progress?.status === "error") && (
            <AICallStatus progress={progress} elapsed={elapsed} showDoneCount />
          )}
        </div>
      )}
      <div className="preview-entry-list">
        {answers.map((answer, index) => (
          <div className="preview-question" key={index}>
            <div className="preview-question-head">
              <span className="pv-seq">第 {index + 1} 题</span>
              <span className="pv-opts">
                {CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className={answer === choice ? "pv-opt on" : "pv-opt"}
                    onClick={() => setAnswers((prev) => prev.map((value, i) => (i === index ? choice : value)))}
                  >
                    {choice}
                  </button>
                ))}
              </span>
            </div>
            <Input.TextArea
              value={explanations[index]}
              onChange={(event) => setExplanations((prev) => prev.map((value, i) => (i === index ? event.target.value : value)))}
              rows={3}
              placeholder="参考解析（可留空）"
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}
