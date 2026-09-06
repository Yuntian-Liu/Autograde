import { useEffect, useState } from "react";
import { App as AntApp, DatePicker, InputNumber, Modal, Select, Switch } from "antd";
import dayjs from "dayjs";
import { apiPatch, apiPost } from "../api";

// 册 → 单元号范围（与后端 feedback.py TERM_UNIT_RANGE 一致）：A=U1-6 上册，B=U7-12 下册
const TERM_UNIT_RANGE = { A: [1, 6], B: [7, 12] };
const SERIES_LESSON_TYPE = { WW: "L", NG: "Day" };
const CONTENT_BY_LESSON_TYPE = { L: "练习", Day: "伴学手册" };

// 时间下拉：半小时步进（00:00 - 23:30）
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  const m = i % 2 === 0 ? "00" : "30";
  return { value: `${h}:${m}`, label: `${h}:${m}` };
});

// 批次创建/编辑表单：课型默认值按班级系列预填（WW→L，NG→Day），可切换
export default function AssignmentForm({ open, onClose, classInfo, assignment, onSaved }) {
  const { message } = AntApp.useApp();
  const editing = Boolean(assignment);
  const [lo, hi] = TERM_UNIT_RANGE[classInfo?.term] || [1, 12];

  const [unitNo, setUnitNo] = useState(lo);
  const [lessonType, setLessonType] = useState("L");
  const [unitLessonNo, setUnitLessonNo] = useState(1);
  const [lessonNo, setLessonNo] = useState(1);
  const [classDate, setClassDate] = useState(null); // dayjs 对象
  const [classHM, setClassHM] = useState(""); // "14:00"
  const [content, setContent] = useState("");
  const [hasPreview, setHasPreview] = useState(false);
  const [previewUnitNo, setPreviewUnitNo] = useState(lo);
  const [previewHalf, setPreviewHalf] = useState(classInfo?.term || "A");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !classInfo) return;
    const [lo_] = TERM_UNIT_RANGE[classInfo.term] || [1, 12];
    if (assignment) {
      setUnitNo(assignment.unit_no);
      setLessonType(assignment.lesson_type);
      setUnitLessonNo(assignment.unit_lesson_no);
      setLessonNo(assignment.lesson_no);
      // class_time 形如 "2026-09-12 14:00"，拆成日期 + 时间两个控件
      const [d, t] = (assignment.class_time || "").split(" ");
      setClassDate(d ? dayjs(d) : null);
      setClassHM(t || "");
      setContent(assignment.content || "");
      setHasPreview(Boolean(assignment.has_preview));
      setPreviewUnitNo(assignment.preview_unit_no ?? lo_);
      setPreviewHalf(assignment.preview_half || classInfo.term);
    } else {
      setUnitNo(lo_);
      setLessonType(SERIES_LESSON_TYPE[classInfo.series] || "L");
      setUnitLessonNo(1);
      setLessonNo((classInfo.next_lesson_no || 1));
      setClassDate(null);
      setClassHM("");
      setContent(CONTENT_BY_LESSON_TYPE[SERIES_LESSON_TYPE[classInfo.series]] || "练习");
      setHasPreview(false);
      setPreviewUnitNo(lo_);
      setPreviewHalf(classInfo.term);
    }
  }, [open, assignment, classInfo]);

  async function submit() {
    if (saving) return;
    if (hasPreview && (previewUnitNo === null || !previewHalf)) {
      message.error("开启预习时必须填写预习单元号与上下册");
      return;
    }
    const payload = {
      unit_no: unitNo,
      lesson_type: lessonType,
      unit_lesson_no: unitLessonNo,
      has_preview: lessonType === "Day" ? hasPreview : false,
      preview_unit_no: hasPreview ? previewUnitNo : null,
      preview_half: hasPreview ? previewHalf : "",
      lesson_no: lessonNo,
      class_time: classDate && classHM ? `${classDate.format("YYYY-MM-DD")} ${classHM}` : "",
      content: content.trim(),
    };
    setSaving(true);
    try {
      if (editing) {
        await apiPatch(`/assignments/${assignment.id}`, payload);
      } else {
        await apiPost(`/classes/${classInfo.id}/assignments`, payload);
      }
      message.success(editing ? "批次已更新" : "批次已创建");
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
      title={editing ? "编辑批次" : "新建批次"}
      okText={editing ? "保存" : "创建"}
      cancelText="取消"
      width={440}
      destroyOnHidden
    >
      <div className="form-grid">
        <span className="flab">单元号</span>
        <InputNumber min={lo} max={hi} value={unitNo} onChange={(v) => setUnitNo(v)} />
        <span className="flab">课型</span>
        <Select
          value={lessonType}
          onChange={(v) => {
            setLessonType(v);
            // 作业内容还是另一课型的默认值时跟随切换（手改过的内容不覆盖）
            setContent((c) =>
              Object.values(CONTENT_BY_LESSON_TYPE).includes(c) || !c
                ? CONTENT_BY_LESSON_TYPE[v]
                : c
            );
          }}
          options={[
            { value: "L", label: "L（练习课）" },
            { value: "Day", label: "Day（伴学手册）" },
          ]}
        />
        <span className="flab">单元内课次</span>
        <InputNumber min={1} max={20} value={unitLessonNo} onChange={(v) => setUnitLessonNo(v)} />
        <span className="flab">第几次课</span>
        <InputNumber min={1} value={lessonNo} onChange={(v) => setLessonNo(v)} />
        <span className="flab">上课日期</span>
        <DatePicker
          value={classDate}
          onChange={setClassDate}
          placeholder="选择日期"
          style={{ width: "100%" }}
          allowClear
        />
        <span className="flab">上课时间</span>
        <Select
          value={classHM || undefined}
          onChange={setClassHM}
          options={TIME_OPTIONS}
          placeholder="选择时间"
          allowClear
          showSearch
        />
        <span className="flab">作业内容</span>
        <Select
          value={content || undefined}
          onChange={setContent}
          options={[
            { value: "练习", label: "练习" },
            { value: "伴学手册", label: "伴学手册" },
          ]}
        />
        {lessonType === "Day" && (
          <>
            <span className="flab">预习</span>
            <Switch checked={hasPreview} onChange={setHasPreview} />
            {hasPreview && (
              <>
                <span className="flab">预习单元号</span>
                <InputNumber
                  min={lo}
                  max={hi}
                  value={previewUnitNo}
                  onChange={(v) => setPreviewUnitNo(v)}
                />
                <span className="flab">上下册</span>
                <Select
                  value={previewHalf}
                  onChange={setPreviewHalf}
                  options={[
                    { value: "A", label: "A（上册）" },
                    { value: "B", label: "B（下册）" },
                  ]}
                />
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
