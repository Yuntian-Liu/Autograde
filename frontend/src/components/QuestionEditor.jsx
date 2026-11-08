import { useEffect, useRef, useState } from "react";
import { App as AntApp, Input, InputNumber, Modal } from "antd";
import { modeLabel } from "../meta";
import { streamAI } from "../utils/aiStream";
import { clientLog } from "../utils/clientLog";
import AICallStatus from "./AICallStatus";

// 统一编辑窗：直出题可个别修订；其余题由老师定稿，AI 只起草。
export default function QuestionEditor({ question, note, score = 0, maxScore = 0, open, onClose, onSave, onUncheck }) {
  const { message } = AntApp.useApp();
  const [text, setText] = useState("");
  const [errorDesc, setErrorDesc] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [scoreValue, setScoreValue] = useState(0);
  const [progress, setProgress] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (open) {
      setText(note || (question?.mode === "verbatim" ? question.explanation || "" : ""));
      setErrorDesc("");
      setEditing(false);
      setScoreValue(Number(score) || 0);
      setProgress(null);
      setElapsed(0);
    }
    return () => {
      abortRef.current?.abort();
      clearInterval(timerRef.current);
    };
  }, [open, note, question, score]);

  if (!question) return null;
  const { mode } = question;
  const scoreChanged = Number(scoreValue) !== Number(score || 0);

  function bumpScore(step) {
    setScoreValue((prev) => Math.max(0, Math.min(maxScore, Number(((prev || 0) + step).toFixed(2)))));
  }

  function cancel() {
    abortRef.current?.abort();
    clearInterval(timerRef.current);
    onClose();
  }

  async function draft() {
    if (!errorDesc.trim()) return message.error("请先描述学生错点");
    const controller = new AbortController();
    abortRef.current = controller;
    setDrafting(true);
    setElapsed(0);
    setProgress({ stage: "preparing", recv_chars: 0 });
    const started = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    clientLog.operation("draft_explanation", "start", { question: question.id });
    try {
      const done = await streamAI("/api/ai/draft-explanation", {
        question_id: question.id,
        error_description: errorDesc,
      }, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "stage") {
            setProgress((prev) => ({ ...prev, ...event, status: "running" }));
          } else if (event.type === "delta") {
            setProgress((prev) => ({ ...prev, stage: "receiving", recv_chars: event.recv_chars, status: "running" }));
          }
        },
      });
      setText(done.draft);
      clientLog.operation("draft_explanation", "success", { question: question.id });
    } catch (e) {
      if (e.name !== "AbortError") {
        setProgress((prev) => ({ ...prev, status: "error", error: e.message }));
        clientLog.operation("draft_explanation", "error", { question: question.id, error: e.message });
        message.error(e.message);
      }
    } finally {
      clearInterval(timerRef.current);
      setDrafting(false);
    }
  }

  return (
    <Modal
      centered
      open={open}
      onCancel={cancel}
      title={`${question.section} · 第 ${question.seq} 题 · ${modeLabel(mode)}`}
      width={520}
      destroyOnHidden
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onUncheck}>取消勾选</button>
          {mode !== "verbatim" && (
            <button className="btn primary" onClick={() => onSave(text, scoreValue)}>定稿</button>
          )}
          {mode === "verbatim" && !editing && (
            <>
              <button className="btn" onClick={() => setEditing(true)}>修改解析</button>
              <button
                className="btn primary"
                onClick={scoreChanged ? () => onSave(note || question.explanation || "", scoreValue) : cancel}
              >
                {scoreChanged ? "保存" : "关闭"}
              </button>
            </>
          )}
          {mode === "verbatim" && editing && (
            <>
              <button
                className="btn"
                onClick={() => {
                  setText(note || question.explanation || "");
                  setEditing(false);
                }}
              >
                取消修改
              </button>
              <button className="btn primary" onClick={() => onSave(text.trim(), scoreValue)}>保存解析</button>
            </>
          )}
        </div>
      }
    >
      <div className="qinfo">
        {question.stem && <div className="qinfo-line">题干：{question.stem}</div>}
        <div className="qinfo-line">答案：{question.standard_answer}</div>
      </div>

      <div className="qscore-row">
        <span className="qscore-label">本题得分</span>
        <InputNumber
          min={0}
          max={maxScore}
          step={0.5}
          precision={2}
          value={scoreValue}
          onChange={(value) => setScoreValue(value ?? 0)}
        />
        <span className="qscore-max">/ {maxScore}</span>
        <span className="qscore-actions">
          <button type="button" className="btn sm qscore-minus" aria-label="减 1 分" onClick={() => bumpScore(-1)}>-1</button>
          <button type="button" className="btn sm qscore-minus" aria-label="减 0.5 分" onClick={() => bumpScore(-0.5)}>-0.5</button>
          <button type="button" className="btn primary sm qscore-plus" aria-label="加 0.5 分" onClick={() => bumpScore(0.5)}>+0.5</button>
          <button type="button" className="btn primary sm qscore-plus" aria-label="加 1 分" onClick={() => bumpScore(1)}>+1</button>
        </span>
      </div>

      {mode === "verbatim" && !editing && (
        <p className="frozen-text">{note || question.explanation || "（本题无冻结解析）"}</p>
      )}
      {mode === "verbatim" && editing && (
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="修改本题解析（仅影响当前学生的反馈）"
        />
      )}
      {mode === "manual" && (
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="填写本题的个性化点评内容"
        />
      )}
      {mode === "ai_expand" && (
        <>
          <div className="qrow-head" style={{ marginBottom: "var(--s3)" }}>
            <Input
              className="grow"
              value={errorDesc}
              onChange={(e) => setErrorDesc(e.target.value)}
              placeholder="描述学生错点，如「I go to park 漏冠词」"
            />
            <button className="btn" onClick={draft} disabled={drafting}>
              {drafting ? "起草中…" : "AI 起草"}
            </button>
          </div>
          {(drafting || progress?.status === "error") && (
            <AICallStatus progress={progress} elapsed={elapsed} compact />
          )}
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="AI 起草结果会填入这里，可手动修改后定稿"
          />
        </>
      )}
    </Modal>
  );
}
