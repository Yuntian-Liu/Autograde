import { useEffect, useState } from "react";
import { App as AntApp, Checkbox, Input, Modal } from "antd";
import { clientLog } from "../utils/clientLog";

export default function StudentImportModal({
  open,
  onClose,
  students = [],
  onImport,
  onImported,
  title = "导入名单",
  existingLabel = "班内已有",
  offerHistoricalAbsence = false,
}) {
  const { message } = AntApp.useApp();
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [dupOpen, setDupOpen] = useState(null);
  const [backfillAbsent, setBackfillAbsent] = useState(true);

  useEffect(() => {
    if (open) setBackfillAbsent(true);
  }, [open]);

  function parseNames() {
    return importText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function doImport(allowDup) {
    setImporting(true);
    try {
      const res = await onImport(parseNames(), allowDup, {
        backfill_absent: offerHistoricalAbsence && backfillAbsent,
      });
      if (offerHistoricalAbsence) {
        clientLog.operation("students_import_backfill", "success", {
          added: res.added,
          enabled: backfillAbsent,
          marked: res.backfill?.marked || 0,
          conflicts: res.backfill?.conflict_count || 0,
        });
      }
      message.success(
        `成功导入 ${res.added} 人` +
          (res.skipped.length ? `，跳过重复 ${res.skipped.length} 人（${res.skipped.join("、")}）` : "") +
          (res.backfill?.marked ? `，历史批次标为未交 ${res.backfill.marked} 份` : "") +
          (res.backfill?.conflict_count ? `，跳过冲突 ${res.backfill.conflict_count} 份` : "")
      );
      setDupOpen(null);
      setImportText("");
      onClose();
      onImported?.(res);
    } catch (e) {
      if (offerHistoricalAbsence) {
        clientLog.operation("students_import_backfill", "error", { enabled: backfillAbsent, error: e.message });
      }
      message.error(e.message);
    } finally {
      setImporting(false);
    }
  }

  function importStudents() {
    const names = parseNames();
    if (names.length === 0) return message.error("请先粘贴名单（一行一个名字）");
    const existingByName = new Map(students.map((s) => [s.name, s]));
    const counts = {};
    names.forEach((n) => (counts[n] = (counts[n] || 0) + 1));
    const dups = [];
    for (const n of new Set(names)) {
      if (existingByName.has(n)) {
        dups.push({ name: n, kind: "existing", code: existingByName.get(n).code });
      } else if (counts[n] > 1) {
        dups.push({ name: n, kind: "repeat" });
      }
    }
    if (dups.length === 0) return doImport(false);
    setDupOpen(dups);
  }

  return (
    <>
      <Modal
        centered
        open={open}
        onCancel={onClose}
        onOk={importStudents}
        confirmLoading={importing}
        title={title}
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
        {offerHistoricalAbsence && (
          <Checkbox
            className="import-history-option"
            checked={backfillAbsent}
            onChange={(event) => setBackfillAbsent(event.target.checked)}
          >
            将转入前已完成批次标为未交
          </Checkbox>
        )}
      </Modal>
      <Modal
        centered
        open={dupOpen !== null}
        onCancel={() => setDupOpen(null)}
        title="检测到重名"
        width={440}
        footer={null}
        zIndex={1010}
      >
        <div className="dup-list">
          {(dupOpen || []).map((d) => (
            <div className="dup-row" key={d.name}>
              <span className="dup-name">{d.name}</span>
              <span className="dup-kind">
                {d.kind === "existing" ? `${existingLabel}${d.code ? ` · ${d.code}` : ""}` : "名单内重复"}
              </span>
            </div>
          ))}
        </div>
        <p className="dup-hint">保留后，重名学生将通过编码（SID）区分；也可以只跳过重名，或返回修改名单。</p>
        <div className="dup-actions">
          <button className="btn" onClick={() => setDupOpen(null)} disabled={importing}>
            返回修改
          </button>
          <button className="btn" onClick={() => doImport(false)} disabled={importing}>
            跳过重名
          </button>
          <button className="btn primary" onClick={() => doImport(true)} disabled={importing}>
            保留重名
          </button>
        </div>
      </Modal>
    </>
  );
}
