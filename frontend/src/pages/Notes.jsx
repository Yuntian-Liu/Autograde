import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { App as AntApp, DatePicker, Input, Modal, Segmented, Select } from "antd";
import { apiGet, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import { fmtBytes, fmtTime } from "../meta";
import { clientLog } from "../utils/clientLog";
import { renderNoteInline } from "../utils/noteFormat";

// 笔记库：活跃/归档双区；搜索（学生名/标题/归档备注）+ 班级筛选 + 时间倒序卡片；新建可选关联，全不选即游离笔记
export default function Notes() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [notes, setNotes] = useState(null);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [classFilter, setClassFilter] = useState(null);
  const [range, setRange] = useState(null); // 创建时间筛选（起止日期，前端内存过滤）
  const [archived, setArchived] = useState(false); // 活跃区 / 归档区
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ class_id: null, student_id: null, assignment_id: null });
  const [classDetail, setClassDetail] = useState(null); // 选中班级的学生/批次选项
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (classFilter) params.set("class_id", String(classFilter));
    params.set("archived", archived ? "true" : "false");
    apiGet(`/notes?${params.toString()}`)
      .then(setNotes)
      .catch((e) => setError(e.message));
  }, [q, classFilter, archived]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiGet("/classes").then(setClasses).catch(() => {});
  }, []);

  // 选中班级后拉该班学生与批次做级联选项
  useEffect(() => {
    setClassDetail(null);
    if (form.class_id) {
      apiGet(`/classes/${form.class_id}`).then(setClassDetail).catch(() => {});
    }
  }, [form.class_id]);

  async function create() {
    setCreating(true);
    try {
      const n = await apiPost("/notes", {
        content: "",
        class_id: form.class_id,
        student_id: form.student_id,
        assignment_id: form.assignment_id,
      });
      setCreateOpen(false);
      setForm({ class_id: null, student_id: null, assignment_id: null });
      clientLog.add(
        "ui",
        `新建笔记：${form.class_id ? `关联 班级#${form.class_id}` : "游离"}${form.student_id ? ` 学生#${form.student_id}` : ""}${form.assignment_id ? ` 批次#${form.assignment_id}` : ""}`
      );
      message.success("笔记已创建");
      load();
      navigate(`/notes/${n.id}`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setCreating(false);
    }
  }

  // 时间筛选在前端内存过滤（数据量小；created_at 是 ISO 串，日期部分可直接字典序比较）
  const shown = (notes || []).filter((n) => {
    if (!range || !range[0] || !range[1]) return true;
    const day = (n.created_at || "").slice(0, 10);
    return day >= range[0].format("YYYY-MM-DD") && day <= range[1].format("YYYY-MM-DD");
  });

  // 汇总：总图片数与总字节（列表接口加总，量小）
  const totalImages = (notes || []).reduce((sum, n) => sum + (n.image_count || 0), 0);
  const totalBytes = (notes || []).reduce((sum, n) => sum + (n.image_size || 0), 0);

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (notes === null)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  return (
    <div className="page-enter">
      <AppHeader crumbs={[{ label: "工作台", to: "/" }, { label: "笔记库" }]} />
      <div className="wrap">
        <Link className="back" to="/">
          ← 工作台
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>笔记库</h1>

        <div style={{ marginTop: "var(--s3)" }}>
          <Segmented
            value={archived ? "archived" : "active"}
            onChange={(v) => setArchived(v === "archived")}
            options={[
              { value: "active", label: "活跃" },
              { value: "archived", label: "归档" },
            ]}
          />
        </div>

        <div className="notes-toolbar" style={{ marginTop: "var(--s3)" }}>
          <Input
            placeholder={archived ? "搜索标题 / 归档备注" : "搜索学生名 / 标题"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            allowClear
          />
          <Select
            allowClear
            placeholder="全部班级"
            value={classFilter}
            onChange={setClassFilter}
            style={{ width: 140, flex: "none" }}
            options={classes.map((c) => ({ value: c.id, label: c.name }))}
          />
          <DatePicker.RangePicker
            value={range}
            onChange={setRange}
            placeholder={["创建起", "创建止"]}
          />
          <button className="btn" onClick={() => navigate("/notes/import")}>
            批量导入
          </button>
          <button className="btn primary" onClick={() => setCreateOpen(true)}>
            + 新建笔记
          </button>
        </div>

        <div className="page-meta" style={{ marginTop: "var(--s3)" }}>
          共 {totalImages} 张图 · {fmtBytes(totalBytes)}
        </div>

        <section className="block">
          {shown.map((n) => (
            <Link className="row note-card" key={n.id} to={`/notes/${n.id}`}>
              <div className="note-card-title">{n.title}</div>
              {n.excerpt && (
                <div
                  className="note-card-excerpt"
                  dangerouslySetInnerHTML={{ __html: renderNoteInline(n.excerpt) }}
                />
              )}
              <div className="note-card-meta">
                {archived
                  ? n.legacy_name
                    ? `归档 · ${n.legacy_name}`
                    : "归档"
                  : n.class_name
                    ? [n.class_name, n.student_name, n.assignment_label].filter(Boolean).join(" · ")
                    : "历史记录"}
                {" · "}
                {n.image_count > 0 ? `${n.image_count} 图 · ${fmtBytes(n.image_size)}` : "纯文本"}
                {" · "}
                {(fmtTime(n.updated_at) || "").slice(0, 10)}
              </div>
            </Link>
          ))}
          {shown.length === 0 && <div className="row">{archived ? "暂无归档笔记" : "暂无笔记"}</div>}
        </section>
      </div>

      <Modal
        centered
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={create}
        confirmLoading={creating}
        title="新建笔记"
        okText="创建"
        cancelText="取消"
        width={440}
        destroyOnHidden
      >
        <div className="form-grid">
          <span className="flab">班级</span>
          <Select
            allowClear
            placeholder="可不选（游离笔记）"
            value={form.class_id}
            onChange={(v) => setForm({ class_id: v ?? null, student_id: null, assignment_id: null })}
            options={classes.map((c) => ({ value: c.id, label: c.name }))}
          />
          <span className="flab">学生</span>
          <Select
            allowClear
            placeholder="可不选"
            disabled={!form.class_id}
            value={form.student_id}
            onChange={(v) => setForm({ ...form, student_id: v ?? null, assignment_id: null })}
            options={(classDetail?.students || []).map((s) => ({ value: s.id, label: s.name }))}
          />
          <span className="flab">批次</span>
          <Select
            allowClear
            placeholder="可不选"
            disabled={!form.class_id}
            value={form.assignment_id}
            onChange={(v) => setForm({ ...form, assignment_id: v ?? null })}
            options={(classDetail?.assignments || []).map((a) => ({
              value: a.id,
              label: `${a.unit_label}（第 ${a.lesson_no} 次课）`,
            }))}
          />
        </div>
      </Modal>
    </div>
  );
}
