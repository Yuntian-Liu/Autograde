import { useEffect, useState } from "react";
import { App as AntApp, DatePicker, Input, InputNumber, Modal, Select, Switch } from "antd";
import dayjs from "dayjs";
import { apiPatch, apiPost } from "../api";
import { clientLog } from "../utils/clientLog";

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

function unitInRange(value, term) {
  const [lo, hi] = TERM_UNIT_RANGE[term] || [1, 12];
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

// 批次创建/编辑表单：课型默认值按班级系列预填（WW→L，NG→Day），可切换
export default function AssignmentForm({ open, onClose, classInfo, assignment, onSaved, temp = false }) {
  const { message, modal } = AntApp.useApp();
  const editing = Boolean(assignment);
  const initialTerm = classInfo?.term || "A";
  const initialUnit = (TERM_UNIT_RANGE[initialTerm] || [1, 12])[0];
  const [series, setSeries] = useState(classInfo?.series || "WW");
  const [level, setLevel] = useState(classInfo?.level ?? 1);
  const [term, setTerm] = useState(initialTerm);
  const [note, setNote] = useState("");
  const [unitNo, setUnitNo] = useState(initialUnit);
  const [lessonType, setLessonType] = useState("L");
  const [unitLessonNo, setUnitLessonNo] = useState(1);
  const [lessonNo, setLessonNo] = useState(1);
  const [classDate, setClassDate] = useState(null); // dayjs 对象
  const [classHM, setClassHM] = useState(""); // "14:00"
  const [content, setContent] = useState("");
  const [hasPreview, setHasPreview] = useState(false);
  const [previewUnitNo, setPreviewUnitNo] = useState(initialUnit);
  const [previewHalf, setPreviewHalf] = useState(initialTerm);
  const [trackingItems, setTrackingItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const activeTerm = temp ? term : classInfo?.term;
  const [lo, hi] = TERM_UNIT_RANGE[activeTerm] || [1, 12];
  const [previewLo, previewHi] = TERM_UNIT_RANGE[activeTerm] || [1, 12];

  useEffect(() => {
    if (!open || !classInfo) return;
    const assignmentClass = assignment?.class;
    const nextSeries = temp ? assignmentClass?.series || "WW" : classInfo.series;
    const nextTerm = temp ? assignmentClass?.term || "A" : classInfo.term;
    const [lo_] = TERM_UNIT_RANGE[nextTerm] || [1, 12];
    setSeries(nextSeries || "WW");
    setLevel(temp ? assignmentClass?.level ?? 1 : classInfo.level ?? 1);
    setTerm(nextTerm || "A");
    setNote(temp ? assignment?.note || "" : "");
    setTrackingItems(
      (assignment?.tracking_items || []).map((item) => ({ id: item.id, name: item.name }))
    );
    if (assignment) {
      setUnitNo(assignment.unit_no);
      setLessonType(assignment.lesson_type);
      setUnitLessonNo(assignment.unit_lesson_no);
      setLessonNo(temp ? 0 : assignment.lesson_no);
      // class_time 形如 "2026-09-12 14:00"，拆成日期 + 时间两个控件
      const [d, t] = (assignment.class_time || "").split(" ");
      setClassDate(d ? dayjs(d) : null);
      setClassHM(t || "");
      setContent(assignment.content || "");
      setHasPreview(Boolean(assignment.has_preview));
      setPreviewUnitNo(assignment.preview_unit_no ?? lo_);
      setPreviewHalf(assignment.preview_half || nextTerm);
    } else {
      setUnitNo(lo_);
      setLessonType(SERIES_LESSON_TYPE[nextSeries] || "L");
      setUnitLessonNo(1);
      setLessonNo(temp ? 0 : classInfo.next_lesson_no || 1);
      setClassDate(null);
      setClassHM("");
      setContent(CONTENT_BY_LESSON_TYPE[SERIES_LESSON_TYPE[nextSeries]] || "练习");
      setHasPreview(false);
      setPreviewUnitNo(lo_);
      setPreviewHalf(nextTerm);
    }
  }, [open, assignment, classInfo, temp]);

  function changeTerm(value) {
    setTerm(value);
    setUnitNo((current) => unitInRange(current, value));
  }

  function changePreviewHalf(value) {
    setPreviewHalf(value);
  }

  function moveTrackingItem(index, offset) {
    setTrackingItems((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeTrackingItem(index) {
    const item = trackingItems[index];
    const remove = () => setTrackingItems((current) => current.filter((_, i) => i !== index));
    if (!item?.id) {
      remove();
      return;
    }
    modal.confirm({
      title: "删除提交项目",
      content: `删除「${item.name}」将同时清除该项目下所有学生的登记。`,
      okText: "确认删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      centered: true,
      zIndex: 1010,
      onOk: remove,
    });
  }

  async function submit() {
    if (saving) return;
    if (hasPreview && (previewUnitNo === null || !previewHalf)) {
      message.error("开启预习时必须填写预习单元号与上下册");
      return;
    }
    const trackingNames = trackingItems.map((item) => item.name.trim());
    if (trackingNames.some((name) => !name)) {
      message.error("提交项目名称不能为空");
      return;
    }
    if (new Set(trackingNames.map((name) => name.toLocaleLowerCase())).size !== trackingNames.length) {
      message.error("提交项目不能重名");
      return;
    }
    const payload = {
      unit_no: unitNo,
      lesson_type: lessonType,
      unit_lesson_no: unitLessonNo,
      has_preview: lessonType === "Day" ? hasPreview : false,
      preview_unit_no: hasPreview ? previewUnitNo : null,
      preview_half: hasPreview ? previewHalf : "",
      lesson_no: temp ? 0 : lessonNo,
      class_time: temp ? "" : classDate && classHM ? `${classDate.format("YYYY-MM-DD")} ${classHM}` : "",
      content: content.trim(),
      tracking_items: editing
        ? trackingItems.map((item) => ({ id: item.id, name: item.name.trim() }))
        : trackingNames,
      ...(temp ? { series, level, term, note: note.trim() } : {}),
    };
    setSaving(true);
    try {
      let saved;
      if (editing) {
        saved = await apiPatch(`/assignments/${assignment.id}`, payload);
      } else {
        saved = await apiPost(`/classes/${classInfo.id}/assignments`, payload);
      }
      const original = assignment?.tracking_items || [];
      const keepIds = new Set(trackingItems.map((item) => item.id).filter(Boolean));
      clientLog.operation("tracking_config", "success", {
        assignment: saved.id,
        added: trackingItems.filter((item) => !item.id).length,
        removed: original.filter((item) => !keepIds.has(item.id)).length,
        total: trackingItems.length,
      });
      message.success(editing ? "批次已更新" : "批次已创建");
      onSaved();
      onClose();
    } catch (e) {
      clientLog.operation("tracking_config", "error", {
        assignment: assignment?.id,
        total: trackingItems.length,
        error: e.message,
      });
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
      width={560}
      destroyOnHidden
    >
      <div className="form-grid">
        {temp && (
          <>
            <span className="flab">系列</span>
            <Select
              value={series}
              onChange={setSeries}
              options={[
                { value: "WW", label: "WW（厚少 · Wonderful World）" },
                { value: "NG", label: "NG（厚中）" },
              ]}
            />
            <span className="flab">级别</span>
            <InputNumber min={1} max={12} value={level} onChange={(v) => setLevel(v)} />
            <span className="flab">上下册</span>
            <Select
              value={term}
              onChange={changeTerm}
              options={[
                { value: "A", label: "A（上册 U1-6）" },
                { value: "B", label: "B（下册 U7-12）" },
              ]}
            />
          </>
        )}
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
        {!temp && (
          <>
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
          </>
        )}
        <span className="flab">作业内容</span>
        <Select
          value={content || undefined}
          onChange={setContent}
          options={[
            { value: "练习", label: "练习" },
            { value: "伴学手册", label: "伴学手册" },
          ]}
        />
        {temp && (
          <>
            <span className="flab">备注</span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
          </>
        )}
        {lessonType === "Day" && (
          <>
            <span className="flab">预习</span>
            <Switch checked={hasPreview} onChange={setHasPreview} />
            {editing && !hasPreview && (assignment?.preview_answers || []).length === 5 && (
              <>
                <span className="flab" />
                <span className="form-warn">关闭预习将清空已录的预习答案、解析与全体学生的预习错题记录</span>
              </>
            )}
            {hasPreview && (
              <>
                <span className="flab">预习单元号</span>
                <InputNumber
                  min={previewLo}
                  max={previewHi}
                  value={previewUnitNo}
                  onChange={(v) => setPreviewUnitNo(v)}
                />
                <span className="flab">上下册</span>
                <Select
                  value={previewHalf}
                  onChange={changePreviewHalf}
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
      <div className="tracking-config">
        <div className="tracking-config-head">
          <span className="flab">提交项目</span>
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => setTrackingItems((current) => [...current, { id: null, name: "" }])}
          >
            添加项目
          </button>
        </div>
        {trackingItems.map((item, index) => (
          <div className="tracking-config-row" key={item.id || `new-${index}`}>
            <Input
              value={item.name}
              maxLength={64}
              placeholder="如 Workbook"
              disabled={saving}
              onChange={(e) =>
                setTrackingItems((current) =>
                  current.map((entry, i) => (i === index ? { ...entry, name: e.target.value } : entry))
                )
              }
            />
            <button
              type="button"
              className="btn tracking-order-btn"
              disabled={saving || index === 0}
              onClick={() => moveTrackingItem(index, -1)}
            >
              上移
            </button>
            <button
              type="button"
              className="btn tracking-order-btn"
              disabled={saving || index === trackingItems.length - 1}
              onClick={() => moveTrackingItem(index, 1)}
            >
              下移
            </button>
            <button
              type="button"
              className="btn danger tracking-order-btn"
              disabled={saving}
              onClick={() => removeTrackingItem(index)}
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
