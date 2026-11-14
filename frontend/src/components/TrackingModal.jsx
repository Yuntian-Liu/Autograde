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
  error,
  saveFailed,
}) {
  const { modal } = AntApp.useApp();
  const saving = pendingCells.size > 0;

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

  return (
    <Modal
      centered
      open={open}
      onCancel={requestClose}
      maskClosable={!saving}
      keyboard={!saving}
      footer={null}
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
