import { useEffect, useMemo, useState } from "react";

// 手写 SVG 六维雷达图：零依赖，像素级贴合设计令牌。
// 同心多边形网格（hairline）+ 当前报告平色多边形 + 可选上一份虚线对比；
// 入场动画 = 从中心放大淡入（prefers-reduced-motion 下关闭，见 styles.css）。

const RINGS = [20, 40, 60, 80, 100]; // 网格分圈（百分制）

function polar(cx, cy, r, i, n) {
  const angle = (-90 + (360 / n) * i) * (Math.PI / 180); // 首轴朝正上方
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function polygonPoints(cx, cy, radius, n, values) {
  return values
    .map((v, i) => {
      const [x, y] = polar(cx, cy, (radius * Math.max(0, Math.min(100, v))) / 100, i, n);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

// dims: [{ key, label, score }] 固定六维；prev: { key: score } 可选对比
export default function RadarChart({ dims, prev = null, size = 440 }) {
  const n = dims.length;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 80; // 标签留边（五字维度名 + 分数，右侧标签不被裁）

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const values = useMemo(() => dims.map((d) => d.score ?? 0), [dims]);
  const prevValues = useMemo(
    () => (prev ? dims.map((d) => prev[d.key] ?? null) : null),
    [dims, prev]
  );

  return (
    <svg
      className="radar"
      viewBox={`0 0 ${size} ${size}`}
      width="100%"
      style={{ maxWidth: size, display: "block", margin: "0 auto", overflow: "visible" }}
      role="img"
      aria-label="能力雷达图"
    >
      {/* 同心网格圈 */}
      {RINGS.map((r) => (
        <polygon
          key={r}
          points={polygonPoints(cx, cy, radius, n, Array(n).fill(r))}
          fill="none"
          stroke="var(--line)"
          strokeWidth={r === 100 ? 1.2 : 1}
        />
      ))}
      {/* 轴线 */}
      {dims.map((d, i) => {
        const [x, y] = polar(cx, cy, radius, i, n);
        return (
          <line key={d.key} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--line)" strokeWidth={1} />
        );
      })}

      {/* 上一份报告（虚线对比） */}
      {prevValues && (
        <polygon
          points={polygonPoints(cx, cy, radius, n, prevValues.map((v) => v ?? 0))}
          fill="var(--ink-3)"
          fillOpacity={0.05}
          stroke="var(--ink-3)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      )}

      {/* 当前报告（入场动画：中心放大淡入） */}
      <g className={`radar-anim${mounted ? " on" : ""}`}>
        <polygon
          points={polygonPoints(cx, cy, radius, n, values)}
          fill="var(--accent)"
          fillOpacity={0.13}
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {values.map((v, i) => {
          const [x, y] = polar(cx, cy, (radius * v) / 100, i, n);
          return (
            <circle key={dims[i].key} className="radar-dot" cx={x} cy={y} r={4}>
              <title>{`${dims[i].label} ${Number(v).toFixed(2)}`}</title>
            </circle>
          );
        })}
      </g>

      {/* 维度标签：轴向外侧，按象限定锚点 */}
      {dims.map((d, i) => {
        const [x, y] = polar(cx, cy, radius + 30, i, n);
        const cos = Math.cos((-90 + (360 / n) * i) * (Math.PI / 180));
        const anchor = Math.abs(cos) < 0.3 ? "middle" : cos > 0 ? "start" : "end";
        const delta = prevValues && prevValues[i] !== null ? d.score - prevValues[i] : null;
        return (
          <text key={d.key} className="radar-label" x={x} y={y} textAnchor={anchor}>
            <tspan className="radar-label-name" x={x} dy={-2}>
              {d.label}
            </tspan>
            <tspan className="radar-label-score" x={x} dy={15}>
              {Number(d.score).toFixed(2)}
              {delta !== null && Math.abs(delta) >= 0.005 && (
                <tspan className={delta > 0 ? "radar-delta up" : "radar-delta down"}>
                  {` ${delta > 0 ? "↑" : "↓"}${Math.abs(delta).toFixed(2)}`}
                </tspan>
              )}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}
