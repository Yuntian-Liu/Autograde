import { useEffect, useState } from "react";
import { App as AntApp, Input, Modal } from "antd";
import { apiPost } from "../api";
import { modeLabel } from "../meta";

// 统一编辑窗（DEVELOPMENT.md 2.6）：按题目 mode 分态
// verbatim 只读展示冻结解析 / manual 空白框填内容 / ai_expand 先填错点 → AI 起草 → 窗内可改 → 定稿
export default function QuestionEditor({ question, note, open, onClose, onSave, onUncheck }) {
  const { message } = AntApp.useApp();
  const [text, setText] = useState("");
  const [errorDesc, setErrorDesc] = useState("");
  const [drafting, setDrafting] = useState(false);

  useEffect(() => {
    if (open) {
      setText(note || "");
      setErrorDesc("");
    }
  }, [open, note]);

  if (!question) return null;
  const { mode } = question;

  async function draft() {
    if (!errorDesc.trim()) return message.error("请先描述学生错点");
    setDrafting(true);
    try {
      const res = await apiPost("/ai/draft-explanation", {
        question_id: question.id,
        error_description: errorDesc,
      });
      setText(res.draft);
    } catch (e) {
      message.error(e.message);
    } finally {
      setDrafting(false);
    }
  }

  return (
    <Modal
      centered
      open={open}
      onCancel={onClose}
      title={`${question.section} · 第 ${question.seq} 题 · ${modeLabel(mode)}`}
      width={520}
      destroyOnHidden
      footer={
        <div className="modal-actions">
          <button className="btn" onClick={onUncheck}>
            取消勾选
          </button>
          {mode !== "verbatim" && (
            <button className="btn primary" onClick={() => onSave(text)}>
              定稿
            </button>
          )}
          {mode === "verbatim" && (
            <button className="btn primary" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      }
    >
      <div className="qinfo">
        {question.stem && <div className="qinfo-line">题干：{question.stem}</div>}
        <div className="qinfo-line">答案：{question.standard_answer}</div>
      </div>

      {mode === "verbatim" && (
        <p className="frozen-text">{question.explanation || "（本题无冻结解析）"}</p>
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
