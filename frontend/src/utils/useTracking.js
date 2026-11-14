import { useCallback, useEffect, useState } from "react";
import { App as AntApp } from "antd";
import { apiGet, apiPut } from "../api";
import { clientLog } from "./clientLog";

function applyCell(data, studentId, itemId, cell) {
  if (!data) return data;
  const oldCell = data.students.find((student) => student.id === studentId)?.cells?.[String(itemId)];
  const delta = Number(Boolean(cell?.submitted)) - Number(Boolean(oldCell?.submitted));
  return {
    ...data,
    items: data.items.map((item) =>
      item.id === itemId ? { ...item, submitted_count: item.submitted_count + delta } : item
    ),
    students: data.students.map((student) =>
      student.id === studentId
        ? { ...student, cells: { ...student.cells, [String(itemId)]: cell } }
        : student
    ),
  };
}

export default function useTracking(assignmentId) {
  const { message } = AntApp.useApp();
  const [tracking, setTracking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pendingCells, setPendingCells] = useState(new Set());

  const reload = useCallback(async () => {
    try {
      const data = await apiGet(`/assignments/${assignmentId}/tracking`);
      setTracking(data);
      setError(null);
      return data;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [assignmentId]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  const toggleCell = useCallback(
    async (studentId, item) => {
      const key = `${studentId}:${item.id}`;
      const student = tracking?.students.find((entry) => entry.id === studentId);
      const previous = student?.cells?.[String(item.id)];
      if (!previous || pendingCells.has(key) || (item.is_main && previous.source === "auto")) {
        return false;
      }
      const submitted = !previous.submitted;
      const optimistic = { submitted, source: submitted ? "manual" : null };
      setPendingCells((current) => new Set(current).add(key));
      setTracking((current) => applyCell(current, studentId, item.id, optimistic));
      try {
        const result = await apiPut(
          `/assignments/${assignmentId}/students/${studentId}/tracking/${item.id}`,
          { submitted }
        );
        setTracking((current) => applyCell(current, studentId, item.id, result.cell));
        setError(null);
        setSaveFailed(false);
        message.success("提交登记已保存");
        clientLog.operation("tracking_save", "success", {
          assignment: assignmentId,
          student: studentId,
          item: item.id,
          main: item.is_main,
          submitted,
        });
        return true;
      } catch (e) {
        setTracking((current) => applyCell(current, studentId, item.id, previous));
        setError(e.message);
        setSaveFailed(true);
        clientLog.operation("tracking_save", "error", {
          assignment: assignmentId,
          student: studentId,
          item: item.id,
          main: item.is_main,
          submitted,
          error: e.message,
        });
        message.error(e.message);
        return false;
      } finally {
        setPendingCells((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [assignmentId, tracking, pendingCells, message]
  );

  return { tracking, loading, error, saveFailed, reload, toggleCell, pendingCells };
}
