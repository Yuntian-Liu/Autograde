import { useEffect, useState } from "react";
import { App as AntApp, AutoComplete, Input, InputNumber, Modal, Select } from "antd";
import { apiPatch } from "../api";
import { MODE_LABELS } from "../meta";

const MODE_OPTIONS = Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }));

// 题库单题编辑窗：题干/答案/解析/模式/权重/板块/题号全可改，走 PATCH
export default function QuestionEditModal({ question, sections, open, onClose, onSaved }) {
  const { message } = AntApp.useApp();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && question) {
      setForm({ ...question, optionsText: (question.options || []).join("\n") });
    }
  }, [open, question]);

  if (!form) return null;
  const patch = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  async function submit() {
    if (!form.section.trim()) return message.error("板块名不能为空");
    if (!form.standard_answer.trim()) return message.error("标准答案不能为空");
    setSaving(true);
    try {
      await apiPatch(`/questions/${question.id}`, {
        section: form.section.trim(),
        seq: form.seq,
        mode: form.mode,
        stem: form.stem,
        options: (form.optionsText || "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        standard_answer: form.standard_answer,
        explanation: form.explanation,
        score_weight: form.score_weight,
      });
      message.success("题目已更新");
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
      title="编辑题目"
      okText="保存"
      cancelText="取消"
      width={520}
      destroyOnHidden
    >
      <div className="form-grid">
        <span className="flab">板块名</span>
        <AutoComplete
          value={form.section}
          options={sections.map((s) => ({ value: s }))}
          onChange={(v) => patch("section", v)}
        />
        <span className="flab">题号</span>
        <InputNumber min={1} value={form.seq} onChange={(v) => patch("seq", v)} />
        <span className="flab">模式</span>
        <Select value={form.mode} onChange={(v) => patch("mode", v)} options={MODE_OPTIONS} />
        <span className="flab">权重</span>
        <InputNumber
          min={0.5}
          step={0.5}
          value={form.score_weight}
          onChange={(v) => patch("score_weight", v)}
        />
        <span className="flab">题干</span>
        <Input.TextArea
          value={form.stem}
          onChange={(e) => patch("stem", e.target.value)}
          autoSize={{ minRows: 1, maxRows: 4 }}
        />
        <span className="flab">选项</span>
        <Input.TextArea
          value={form.optionsText}
          onChange={(e) => patch("optionsText", e.target.value)}
          placeholder={"一行一个选项\nA. forest\nB. river"}
          autoSize={{ minRows: 1, maxRows: 6 }}
        />
        <span className="flab">标准答案</span>
        <Input
          value={form.standard_answer}
          onChange={(e) => patch("standard_answer", e.target.value)}
        />
        <span className="flab">解析</span>
        <Input.TextArea
          value={form.explanation}
          onChange={(e) => patch("explanation", e.target.value)}
          autoSize={{ minRows: 2, maxRows: 8 }}
        />
      </div>
    </Modal>
  );
}
