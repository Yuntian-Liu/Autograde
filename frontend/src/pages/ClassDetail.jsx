import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { App as AntApp, Input, Modal, Popconfirm } from "antd";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import AssignmentForm from "../components/AssignmentForm";
import ClassForm from "../components/ClassForm";
import PageSkeleton from "../components/PageSkeleton";
import { classMeta, seriesLabel } from "../meta";

function batchStatus(a) {
  if (a.status === "已完成") return <span className="status-done">已完成</span>;
  if (a.status === "批改中") return <span className="status-doing">批改中</span>;
  return <span className="status-idle">{a.status}</span>;
}

export default function ClassDetail() {
  const { id } = useParams();
  const { message } = AntApp.useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [classFormOpen, setClassFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [noteStudent, setNoteStudent] = useState(null); // 备注编辑目标
  const [noteText, setNoteText] = useState("");
  const [deleteStep, setDeleteStep] = useState(0); // 删除班级双重确认：0=关 1=警示 2=输名确认
  const [deleteNameInput, setDeleteNameInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  const reload = useCallback(() => {
    apiGet(`/classes/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function importStudents() {
    const names = importText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return message.error("请先粘贴名单（一行一个名字）");
    setImporting(true);
    try {
      const res = await apiPost(`/classes/${id}/students/batch`, { names });
      message.success(
        `成功导入 ${res.added} 人` +
          (res.skipped.length ? `，跳过重复 ${res.skipped.length} 人（${res.skipped.join("、")}）` : "")
      );
      setImportOpen(false);
      setImportText("");
      reload();
    } catch (e) {
      message.error(e.message);
    } finally {
      setImporting(false);
    }
  }

  async function saveNote() {
    try {
      await apiPatch(`/students/${noteStudent.id}`, { note: noteText.trim() });
      message.success("备注已保存");
      setNoteStudent(null);
      reload();
    } catch (e) {
      message.error(e.message);
    }
  }

  async function removeStudent(sid) {
    try {
      await apiDelete(`/students/${sid}`);
      message.success("学生已删除");
      reload();
    } catch (e) {
      message.error(e.message);
    }
  }

  async function deleteClass() {
    if (deleteNameInput.trim() !== data.name) return;
    setDeleting(true);
    try {
      await apiDelete(`/classes/${id}`);
      message.success(`班级「${data.name}」已删除`);
      navigate("/");
    } catch (e) {
      // 非空班级会被后端拒绝，直接展示后端中文报错
      message.error(e.message);
      setDeleteStep(0);
    } finally {
      setDeleting(false);
    }
  }

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!data)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const nextLessonNo = Math.max(0, ...data.assignments.map((a) => a.lesson_no)) + 1;

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          { label: `${seriesLabel(data.series)} ${data.name}` },
        ]}
      />
      <div className="wrap">
        <Link className="back" to="/">
          ← 工作台
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>{data.name}</h1>
        <div className="page-meta">
          {seriesLabel(data.series)} · {classMeta(data)} · {data.student_count} 名学生
        </div>
        <div className="btn-row" style={{ marginTop: "var(--s3)" }}>
          <Link className="btn" to={`/classes/${id}/stats`}>
            班级统计
          </Link>
          <button className="btn" onClick={() => setClassFormOpen(true)}>
            编辑班级
          </button>
          <button
            className="btn danger"
            onClick={() => {
              setDeleteNameInput("");
              setDeleteStep(1);
            }}
          >
            删除班级
          </button>
        </div>

        <section className="block">
          <div className="sec-title sec-title-row">
            批次
            <button className="btn" onClick={() => setFormOpen(true)}>
              + 新建批次
            </button>
          </div>
          {data.assignments.map((a) => (
            <Link className="row" key={a.id} to={`/assignments/${a.id}`}>
              <span className="row-name">
                {a.unit_label} {a.content}
                <span>
                  第 {a.lesson_no} 次课{a.class_time ? ` · ${a.class_time}` : ""}
                </span>
              </span>
              <span className="mono">
                {a.graded_count} / {a.total_students}
              </span>
              {batchStatus(a)}
            </Link>
          ))}
          {data.assignments.length === 0 && <div className="row">暂无批次</div>}
        </section>

        <section className="block">
          <div className="sec-title sec-title-row">
            学生
            <button className="btn" onClick={() => setImportOpen(true)}>
              导入名单
            </button>
          </div>
          {data.students.map((s) => (
            <div className="row" key={s.id}>
              <Link className="row-name row-link" to={`/classes/${id}/students/${s.id}`}>
                {s.name}
                {s.note && <span>{s.note}</span>}
              </Link>
              <button
                className="btn"
                onClick={() => {
                  setNoteStudent(s);
                  setNoteText(s.note || "");
                }}
              >
                备注
              </button>
              <Popconfirm
                title={`删除学生「${s.name}」？其批改记录将一并清除`}
                okText="删除"
                cancelText="取消"
                onConfirm={() => removeStudent(s.id)}
              >
                <button className="btn">删除</button>
              </Popconfirm>
            </div>
          ))}
          {data.students.length === 0 && <div className="row">暂无学生</div>}
        </section>
      </div>

      <AssignmentForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        classInfo={{ ...data, next_lesson_no: nextLessonNo }}
        onSaved={reload}
      />
      <ClassForm
        open={classFormOpen}
        onClose={() => setClassFormOpen(false)}
        classInfo={data}
        onSaved={reload}
      />
      <Modal
        centered
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={importStudents}
        confirmLoading={importing}
        title="导入名单"
        okText="导入"
        cancelText="取消"
        width={400}
        destroyOnHidden
      >
        <Input.TextArea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={10}
          placeholder={"一行一个名字\nAmy\nBob"}
        />
      </Modal>
      <Modal
        centered
        open={noteStudent !== null}
        onCancel={() => setNoteStudent(null)}
        onOk={saveNote}
        title={noteStudent ? `${noteStudent.name} 的备注` : "备注"}
        okText="保存"
        cancelText="取消"
        width={400}
        destroyOnHidden
      >
        <Input.TextArea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          rows={4}
          placeholder="仅自己可见"
        />
      </Modal>

      {/* 删除班级 · 第一重：红色警示 */}
      <Modal
        centered
        open={deleteStep === 1}
        onCancel={() => setDeleteStep(0)}
        title={<span className="danger-title">删除班级「{data.name}」？</span>}
        width={440}
        destroyOnHidden
        footer={
          <div className="modal-actions">
            <button className="btn" onClick={() => setDeleteStep(0)}>
              取消
            </button>
            <button className="btn danger-solid" onClick={() => setDeleteStep(2)}>
              继续
            </button>
          </div>
        }
      >
        <p>此操作不可恢复，将尝试永久删除该班级：</p>
        <ul className="danger-list">
          <li>班级下的全部学生</li>
          <li>全部作业批次与题库</li>
          <li>全部批改记录与反馈快照</li>
        </ul>
        <p>名下还有学生或批次的班级会被系统拒绝删除。</p>
      </Modal>

      {/* 删除班级 · 第二重：输入完整班级名匹配后才可点 */}
      <Modal
        centered
        open={deleteStep === 2}
        onCancel={() => setDeleteStep(0)}
        title={<span className="danger-title">确认永久删除</span>}
        width={440}
        destroyOnHidden
        footer={
          <div className="modal-actions">
            <button className="btn" onClick={() => setDeleteStep(0)}>
              取消
            </button>
            <button
              className="btn danger-solid"
              disabled={deleteNameInput.trim() !== data.name}
              onClick={deleteClass}
            >
              {deleting ? "删除中…" : "永久删除"}
            </button>
          </div>
        }
      >
        <div className="form-grid">
          <span className="flab">输入班级名</span>
          <Input
            value={deleteNameInput}
            onChange={(e) => setDeleteNameInput(e.target.value)}
            placeholder={data.name}
            onPressEnter={deleteClass}
          />
        </div>
      </Modal>
    </div>
  );
}
