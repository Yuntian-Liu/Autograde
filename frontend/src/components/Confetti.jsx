import { useEffect, useState } from "react";

// 注册成功撒花 — 纯 CSS keyframes 零依赖（照 Stellaris Confetti，配色换 tokens 青绿系）
// fixed 全屏覆盖、pointer-events 不挡交互；播 ~3.6s 后整体淡出并自卸载
const COLORS = [
  "var(--accent)",
  "var(--accent-hover)",
  "var(--accent-line)",
  "var(--success)",
  "var(--warning)",
];

export default function Confetti() {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setGone(true), 4000);
    return () => clearTimeout(t);
  }, []);

  if (gone) return null;

  return (
    <div aria-hidden className="confetti-wrap">
      {Array.from({ length: 40 }).map((_, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={{
            left: `${(i * 2.5) % 100}%`,
            width: 8 + (i % 3) * 2,
            height: 12 + (i % 3) * 3,
            background: COLORS[i % COLORS.length],
            animation: `confettiFall ${2.5 + (i % 3) * 0.5}s ease-in ${(i % 10) * 0.12}s 1 both`,
          }}
        />
      ))}
      <style>{`
        .confetti-wrap {
          position: fixed; inset: 0; overflow: hidden;
          pointer-events: none; z-index: 1000;
          animation: confettiWrapFade 0.4s var(--ease) 3.2s both;
        }
        .confetti-piece { position: absolute; top: -20px; border-radius: 2px; }
        @keyframes confettiFall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          80% { opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
        @keyframes confettiWrapFade { to { opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .confetti-wrap { display: none; } }
      `}</style>
    </div>
  );
}
