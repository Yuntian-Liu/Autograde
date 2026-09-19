import { useEffect, useState } from "react";
import { App as AntApp, Modal } from "antd";
import { apiPatch } from "../api";
import { clientLog } from "../utils/clientLog";

const CHOICES = ["A", "B", "C", "D"];

// 预习答题卡：固定 5 题纯答案录入（A/B/C/D），不算分、不出解析、不走 AI
export default function PreviewEntry({ open, onClose, assignment, onSaved }) {
  const { message } = AntApp.useApp();
  const [answers, setAnswers] = useState(Array(5).fill(""));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const existing = assignment?.preview_answers || [];
      setAnswers(Array.from({ length: 5 }, (_, i) => existing[i] || ""));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const complete = answers.every(Boolean);

  async function submit() {
    if (!complete) return;
    setSaving(true);
    try {
      await apiPatch(`/assignments/${assignment.slug || assignment.id}`, {
        preview_answers: answers,
      });
      clientLog.add("ui", `预习答案保存：批次${assignment.id}`);
      message.success("预习答案已保存");
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
      onCancel={onClose}
      onOk={submit}
      confirmLoading={saving}
      okButtonProps={{ disabled: !complete }}
      title="预习答案"
      okText="保存"
      cancelText="取消"
      width={420}
      destroyOnHidden
    >
      {answers.map((v, i) => (
        <div className="pv-row" key={i}>
          <span className="pv-seq">第 {i + 1} 题</span>
          <span className="pv-opts">
            {CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                className={v === c ? "pv-opt on" : "pv-opt"}
                onClick={() =>
                  setAnswers((prev) => prev.map((x, j) => (j === i ? c : x)))
                }
              >
                {c}
              </button>
            ))}
          </span>
        </div>
      ))}
    </Modal>
  );
}
