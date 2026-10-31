import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clientLog } from "../utils/clientLog";
import { IconDoc } from "./icons";

const MARGIN = 16;
const DEFAULT_TOP = 72;

function panelSize() {
  return {
    w: Math.min(420, window.innerWidth - MARGIN * 2),
    h: Math.min(620, Math.max(240, window.innerHeight - 88)),
  };
}

function clampPos(x, y, size) {
  return {
    x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - size.w - MARGIN)),
    y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - size.h - MARGIN)),
  };
}

export default function AnswerFloat({ assignment }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState(panelSize);
  const [pos, setPos] = useState({ x: MARGIN, y: DEFAULT_TOP });
  const dragRef = useRef(null);

  function openPanel() {
    const nextSize = panelSize();
    setSize(nextSize);
    setPos(clampPos(window.innerWidth - nextSize.w - 24, DEFAULT_TOP, nextSize));
    setOpen(true);
    clientLog.add("ui", `answer_float_open assignment=${assignment.id}`);
  }

  function closePanel() {
    setOpen(false);
    clientLog.add("ui", `answer_float_close assignment=${assignment.id}`);
  }

  useEffect(() => {
    function onResize() {
      const nextSize = panelSize();
      setSize(nextSize);
      setPos((prev) => clampPos(prev.x, prev.y, nextSize));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") closePanel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function onPointerDown(event) {
    if (event.target.closest("button")) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: pos.x,
      baseY: pos.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) setPos(clampPos(drag.baseX + dx, drag.baseY + dy, size));
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  const previewAnswers = assignment.preview_answers || [];
  const previewReady = Boolean(assignment.has_preview) && previewAnswers.length === 5;

  return (
    <>
      <button
        type="button"
        className="btn answer-float-trigger"
        aria-expanded={open}
        aria-controls="answer-quick-float"
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <IconDoc />答案速查
      </button>
      {open && createPortal(
        <div
          id="answer-quick-float"
          className="answer-float"
          role="dialog"
          aria-modal="false"
          aria-label="答案速查"
          style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
        >
          <div
            className="answer-float-head"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <span>答案速查</span>
            <button type="button" className="answer-float-close" aria-label="关闭答案速查" onClick={closePanel}>×</button>
          </div>
          <div className="answer-float-body">
            {assignment.sections.length === 0 && <div className="row">题库待录入</div>}
            <div className="qa-grid">
              {assignment.sections.map((section) => (
                <div className="qa-sec" key={section.section}>
                  <div className="qa-sec-name">{section.section}</div>
                  <div className="qa-chips">
                    {section.questions.map((question) => (
                      <span
                        className={`qa-chip${question.standard_answer.length > 12 ? " long" : ""}`}
                        key={question.id}
                      >
                        <b>{question.seq}</b>
                        <span className="qa-ans">{question.standard_answer}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {assignment.has_preview && (
                <div className="qa-sec">
                  <div className="qa-sec-name">
                    预习 · {assignment.unit_progress?.split("&")[1] || "Preview"} · 不计分
                  </div>
                  {previewReady ? (
                    <div className="qa-chips">
                      {previewAnswers.map((answer, index) => (
                        <span className="qa-chip" key={index}>
                          <b>{index + 1}</b>
                          <span className="qa-ans">{answer}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="row">预习答案未录入</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
