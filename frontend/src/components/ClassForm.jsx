import { useEffect, useState } from "react";
import { App as AntApp, Input, InputNumber, Modal, Select } from "antd";
import { apiPatch, apiPost } from "../api";

// 上课时间选项：周几 × 半小时粒度（存储仍为「周六 14:00」字符串，旧数据兼容）
const WEEKDAY_OPTIONS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((d) => ({
  value: d,
  label: d,
}));
const TIME_OPTIONS = [];
for (let h = 8; h <= 21; h++) {
  TIME_OPTIONS.push({ value: `${String(h).padStart(2, "0")}:00`, label: `${String(h).padStart(2, "0")}:00` });
  if (h < 21)
    TIME_OPTIONS.push({ value: `${String(h).padStart(2, "0")}:30`, label: `${String(h).padStart(2, "0")}:30` });
}

// 旧值「周六 14:00」拆回两个下拉；格式不符时逐项回落默认
function parseSchedule(raw) {
  const [day, time] = String(raw || "").trim().split(/\s+/);
  return {
    day: WEEKDAY_OPTIONS.some((o) => o.value === day) ? day : "周六",
    time: TIME_OPTIONS.some((o) => o.value === time) ? time : "14:00",
  };
}

// 届别默认值：按当前月份猜学期（与后端 codes.default_cohort 同规则；1-2 月归冬）
const SEASON_OPTIONS = [
  { value: "01", label: "春季" },
  { value: "02", label: "夏季" },
  { value: "03", label: "秋季" },
  { value: "04", label: "冬季" },
];
function defaultCohort() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const season = m >= 3 && m <= 6 ? "01" : m >= 7 && m <= 8 ? "02" : m >= 9 ? "03" : "04";
  return { year: now.getFullYear(), season };
}

// 班级创建/编辑：series WW=厚少 / NG=厚中；册 A=U1-6 上册 / B=U7-12 下册
export default function ClassForm({ open, onClose, classInfo, onSaved }) {
  const { message } = AntApp.useApp();
  const editing = Boolean(classInfo?.id);

  const [name, setName] = useState("");
  const [series, setSeries] = useState("WW");
  const [level, setLevel] = useState(1);
  const [term, setTerm] = useState("A");
  const [cohortYear, setCohortYear] = useState(2026);
  const [cohortSeason, setCohortSeason] = useState("03");
  const [day, setDay] = useState("周六");
  const [time, setTime] = useState("14:00");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(classInfo?.name || "");
    setSeries(classInfo?.series || "WW");
    setLevel(classInfo?.level ?? 1);
    setTerm(classInfo?.term || "A");
    // 编辑时拆已有 cohort；新建/缺省按当前学期猜
    const m = /^(\d{4})(0[1-4])$/.exec(classInfo?.cohort || "");
    const fallback = defaultCohort();
    setCohortYear(m ? Number(m[1]) : fallback.year);
    setCohortSeason(m ? m[2] : fallback.season);
    const parsed = parseSchedule(classInfo?.schedule);
    setDay(parsed.day);
    setTime(parsed.time);
  }, [open, classInfo]);

  async function submit() {
    if (saving) return;
    if (!name.trim()) return message.error("班级名不能为空");
    const payload = {
      name: name.trim(),
      series,
      level,
      term,
      cohort: `${cohortYear}${cohortSeason}`,
      schedule: `${day} ${time}`,
    };
    setSaving(true);
    try {
      if (editing) {
        await apiPatch(`/classes/${classInfo.id}`, payload);
      } else {
        await apiPost("/classes", payload);
      }
      message.success(editing ? "班级已更新" : "班级已创建");
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
      title={editing ? "编辑班级" : "新建班级"}
      okText={editing ? "保存" : "创建"}
      cancelText="取消"
      width={400}
      destroyOnHidden
    >
      <div className="form-grid">
        <span className="flab">班级名</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 WW6A" />
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
        <span className="flab">册别</span>
        <Select
          value={term}
          onChange={setTerm}
          options={[
            { value: "A", label: "A（上册 U1-6）" },
            { value: "B", label: "B（下册 U7-12）" },
          ]}
        />
        <span className="flab">届别</span>
        <div className="schedule-pick">
          <Select
            value={cohortYear}
            onChange={setCohortYear}
            options={[cohortYear - 1, cohortYear, cohortYear + 1, cohortYear + 2]
              .filter((y, i, arr) => arr.indexOf(y) === i)
              .map((y) => ({ value: y, label: `${y} 年` }))}
          />
          <Select value={cohortSeason} onChange={setCohortSeason} options={SEASON_OPTIONS} />
        </div>
        <span className="flab">上课时间</span>
        <div className="schedule-pick">
          <Select value={day} onChange={setDay} options={WEEKDAY_OPTIONS} />
          <Select value={time} onChange={setTime} options={TIME_OPTIONS} />
        </div>
      </div>
    </Modal>
  );
}
