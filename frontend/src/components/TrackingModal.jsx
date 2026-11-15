import { App as AntApp, Modal } from "antd";
import SaveStatus from "./SaveStatus";
import TrackingCell from "./TrackingCell";

export default function TrackingModal({
  open,
  onClose,
  student,
  items = [],
  pendingCells,
  onToggle,
  onComplete,
  error,
  saveFailed,
}) {
  const { modal } = AntApp.useApp();
  const saving = pendingCells.size > 0;
  const confirming = student ? pendingCells.has(`${student.id}:confirmation`) : false;
  const confirmed = Boolean(student?.confirmed_at);
  const hasCustomItems = items.some((item) => !item.is_main);

  function requestClose() {
    if (!saving) {
      onClose();
      return;
    }
    modal.warning({
      title: "登记正在保存",
      content: "请等待保存完成后再关闭，避免结果不确定。",
      okText: "继续等待",
      centered: true,
      zIndex: 1010,
    });
  }

  async function complete() {
    if (!student || saving) return;
    if (confirmed) {
      onClose();
      return;
    }
    await onComplete(student.id);
  }

  return (
    <Modal
      centered
      open={open}
      onCancel={requestClose}
      maskClosable={!saving}
      keyboard={!saving}
      footer={
        <div className="tracking-modal-footer">
          <button type="button" className="btn" onClick={requestClose}>关闭</button>
          {hasCustomItems && (
            <button
              type="button"
              className="btn primary"
              disabled={saving || !student}
              onClick={complete}
            >
              {confirming ? "保存中…" : confirmed ? "已完成登记" : "完成登记"}
            </button>
          )}
        </div>
      }
      title={
        <div className="tracking-modal-title">
          <span>{student ? `提交登记 · ${student.name}` : "提交登记"}</span>
          <SaveStatus dirty={false} saving={saving} failed={saveFailed} />
        </div>
      }
      width={460}
    >
      {error && <div className="page-error">{error}</div>}
      <div className="tracking-modal-list">
        {student && items.map((item) => (
          <div className="tracking-modal-row" key={item.id}>
            <span className="tracking-modal-name">
              {item.is_main ? `本次作业 · ${item.name}` : item.name}
            </span>
            <TrackingCell
              item={item}
              cell={student.cells?.[String(item.id)]}
              saving={pendingCells.has(`${student.id}:${item.id}`)}
              onToggle={() => onToggle(student.id, item)}
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}
