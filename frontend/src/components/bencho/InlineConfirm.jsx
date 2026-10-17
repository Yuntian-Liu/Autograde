import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, LoaderCircle, RefreshCw, Trash2, Undo2 } from "lucide-react";
import "./bencho.css";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hold = (event) => event.stopPropagation();

function textWidth(text) {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) > 0xff ? 13 : 7;
  return width;
}

export default function InlineConfirm({
  label = "删除",
  doneLabel = "已删除",
  undoLabel = "撤销",
  pendingLabel = "处理中…",
  grace = 4000,
  height = 32,
  danger = false,
  disabled = false,
  onCommit,
  onUndo,
  onPhaseChange,
  onBusyChange,
}) {
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const timer = useRef(undefined);
  const mounted = useRef(false);
  const commitRef = useRef(onCommit);

  useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    onPhaseChange?.(phase);
    onBusyChange?.(phase === "undo" || phase === "committing");
  }, [phase, onPhaseChange, onBusyChange]);

  async function execute() {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setError("");
    setPhase("committing");
    try {
      await commitRef.current?.();
      if (mounted.current) setPhase("idle");
    } catch (commitError) {
      if (!mounted.current) return;
      setError(commitError?.message || "操作失败，请重试");
      setPhase("error");
    }
  }

  function arm() {
    if (disabled || phase !== "idle") return;
    setError("");
    setPhase("undo");
    timer.current = window.setTimeout(execute, grace);
  }

  function undo() {
    if (phase !== "undo") return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setPhase("idle");
    onUndo?.();
  }

  const done = phase === "undo";
  const committing = phase === "committing";
  const failed = phase === "error";
  const iconIdle = height >= 40 ? 15 : 13;
  const iconDone = height >= 40 ? 14 : 12;
  const idleWidth = Math.ceil(iconIdle + 8 + textWidth(label) + 16 * 2);
  const doneWidth = Math.ceil(
    iconDone + 7 + textWidth(doneLabel) + 14 * 2 + (height - 8) + textWidth(undoLabel) + 13 * 2 + 4,
  );
  const width = done ? doneWidth : idleWidth;
  const spring = done
    ? { type: "spring", stiffness: 420, damping: 20, mass: 0.9 }
    : { type: "spring", stiffness: 460, damping: 30, mass: 0.9 };
  const radius = clamp(height / 2, 0, 22);

  return (
    <div className="inline-confirm">
      {failed && (
        <span className="inline-confirm-error" role="alert">
          {error}
        </span>
      )}
      <div
        className={`say-well${danger ? " say-well--danger" : ""}`}
        data-phase={phase}
        style={{ "--say-r": `${radius}px`, "--say-h": `${height}px`, width: idleWidth, height }}
      >
        <motion.span className="say-body" initial={false} animate={{ width }} transition={spring} />

        <AnimatePresence initial={false}>
          {!done && !committing && (
            <motion.button
              key="idle"
              type="button"
              className="say-face"
              style={{ right: 0, width }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.18, delay: 0.08 } }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              onClick={failed ? execute : arm}
              onPointerDown={hold}
              disabled={disabled}
              aria-label={failed ? `重试${label}` : label}
            >
              {failed ? <RefreshCw size={iconIdle} strokeWidth={2} /> : <Trash2 size={iconIdle} strokeWidth={2} />}
              {failed ? "重试" : label}
            </motion.button>
          )}

          {done && (
            <motion.div
              key="done"
              className="say-merged"
              style={{ right: 0, width }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.2, delay: 0.1 } }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              aria-live="polite"
            >
              <span className="say-done">
                <Check size={iconDone} strokeWidth={2} />
                {doneLabel}
              </span>
              <button type="button" className="say-undo" onClick={undo} onPointerDown={hold}>
                <Undo2 size={iconDone - 1} strokeWidth={2} />
                {undoLabel}
              </button>
              <i className="say-fuse" style={{ animationDuration: `${grace}ms` }} aria-hidden="true" />
            </motion.div>
          )}

          {committing && (
            <motion.div
              key="committing"
              className="say-pending"
              style={{ right: 0, width }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              role="status"
            >
              <LoaderCircle size={iconIdle} strokeWidth={2} />
              {pendingLabel}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
