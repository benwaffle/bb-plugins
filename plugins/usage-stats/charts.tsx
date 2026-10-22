import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

/** A series drawn with categorical slot `color`, a CSS custom property such as `--series-1`. */
export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

export interface TooltipContent {
  title: string;
  rows: readonly TooltipRow[];
  total?: TooltipRow;
}

interface TooltipApi {
  show(event: ReactMouseEvent, content: TooltipContent): void;
  hide(): void;
}

const TooltipContext = createContext<TooltipApi>({ show() {}, hide() {} });

/** One tooltip for every chart under it, following the pointer and kept on screen. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ x: number; y: number; content: TooltipContent } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<TooltipApi>({
    show(event, content) {
      setState({ x: event.clientX, y: event.clientY, content });
    },
    hide() {
      setState(null);
    },
  });
  const width = ref.current?.offsetWidth ?? 190;
  const height = ref.current?.offsetHeight ?? 80;
  const left = state === null ? 0 : Math.min(state.x + 14, window.innerWidth - width - 8);
  const top = state === null ? 0 : Math.min(state.y + 14, window.innerHeight - height - 8);
  return (
    <TooltipContext.Provider value={api.current}>
      {children}
      <div ref={ref} className="us-tip" role="tooltip" style={{ left, top, opacity: state === null ? 0 : 1 }}>
        {state !== null && (
          <>
            <div className="us-tip-title">{state.content.title}</div>
            {state.content.rows.map((row) => (
              <TipRow key={row.label} row={row} />
            ))}
            {state.content.total !== undefined && (
              <div className="us-tip-total">
                <TipRow row={state.content.total} />
              </div>
            )}
          </>
        )}
      </div>
    </TooltipContext.Provider>
  );
}

function TipRow({ row }: { row: TooltipRow }) {
  return (
    <div className="us-tip-row">
      <span>
        {row.color !== undefined && <i style={{ background: `var(${row.color})` }} />}
        {row.label}
      </span>
      <span>{row.value}</span>
    </div>
  );
}

export function useTooltip(): TooltipApi {
  return useContext(TooltipContext);
}

/** The element's content width, following resizes; `fallback` before the first layout. */
export function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.clientWidth || fallback);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

/** The smallest round number at or above `value` that splits into four even ticks. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** A bar path with 4px rounded data-end corners and a square baseline. */
function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, height, width / 2));
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function roundedEnd(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width, height / 2));
  return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
}

export interface StackedBar {
  key: string;
  label: string;
  /** The tooltip title. */
  detail: string;
  values: Readonly<Record<string, number>>;
  /** Drawn at reduced opacity, as context for a highlighted bar. */
  muted?: boolean;
}

export function StackedBarChart({
  bars,
  series,
  format,
  label,
  height = 250,
}: {
  bars: readonly StackedBar[];
  series: readonly Series[];
  format: (value: number) => string;
  label: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(760);
  const tooltip = useTooltip();
  const [hovered, setHovered] = useState<string | null>(null);
  const left = 52;
  const right = 8;
  const top = 8;
  const bottom = 24;
  const totals = bars.map((bar) => series.reduce((sum, s) => sum + (bar.values[s.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const slot = (width - left - right) / Math.max(1, bars.length);
  const barWidth = Math.max(2, Math.min(22, slot * 0.72));
  const labelEvery = Math.ceil(bars.length / 8);

  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={label}>
        {[0, 1, 2, 3, 4].map((step) => {
          const value = (max / 4) * step;
          return (
            <g key={step}>
              <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={step === 0 ? "us-axis" : "us-grid"} />
              <text x={left - 8} y={y(value) + 4} textAnchor="end">
                {format(value)}
              </text>
            </g>
          );
        })}
        {bars.map((bar, index) => {
          const x = left + index * slot + (slot - barWidth) / 2;
          const drawn = series.filter((s) => (bar.values[s.key] ?? 0) > 0);
          let accumulated = 0;
          const showLabel = (index % labelEvery === 0 && bars.length - 1 - index >= labelEvery / 2) || index === bars.length - 1;
          return (
            <g key={bar.key}>
              <g opacity={bar.muted === true ? 0.35 : 1} className={hovered === bar.key ? "us-hot" : undefined}>
                {drawn.map((s, position) => {
                  const value = bar.values[s.key] ?? 0;
                  const y0 = y(accumulated);
                  const y1 = y(accumulated + value);
                  accumulated += value;
                  const segment = Math.max(0, y0 - y1 - (position > 0 ? 2 : 0));
                  const fill = `var(${s.color})`;
                  return position === drawn.length - 1 ? (
                    <path key={s.key} d={roundedTop(x, y1, barWidth, segment, Math.min(4, barWidth / 2))} fill={fill} />
                  ) : (
                    <rect key={s.key} x={x} y={y1} width={barWidth} height={segment} fill={fill} />
                  );
                })}
              </g>
              {showLabel && (
                <text x={x + barWidth / 2} y={height - 6} textAnchor="middle">
                  {bar.label}
                </text>
              )}
              <rect
                x={left + index * slot}
                y={top}
                width={slot}
                height={height - top - bottom}
                fill="transparent"
                onMouseMove={(event) => {
                  setHovered(bar.key);
                  tooltip.show(event, {
                    title: bar.detail,
                    rows: [...series].reverse().map((s) => ({ label: s.label, value: format(bar.values[s.key] ?? 0), color: s.color })),
                    total: { label: "Total", value: format(totals[index] ?? 0) },
                  });
                }}
                onMouseLeave={() => {
                  setHovered(null);
                  tooltip.hide();
                }}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export interface LinePoint {
  key: string;
  label: string;
  value: number | null;
}

/** One series over time, gaps where `value` is null, with a crosshair tooltip. */
export function LineChart({
  points,
  domain,
  ticks,
  format,
  label,
  valueLabel,
  height = 190,
}: {
  points: readonly LinePoint[];
  domain: readonly [number, number];
  ticks: readonly number[];
  format: (value: number) => string;
  label: string;
  valueLabel: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(340);
  const tooltip = useTooltip();
  const [hovered, setHovered] = useState<number | null>(null);
  const left = 40;
  const right = 8;
  const top = 8;
  const bottom = 22;
  const [low, high] = domain;
  const x = (index: number) => left + ((width - left - right) * index) / Math.max(1, points.length - 1);
  const y = (value: number) => top + (height - top - bottom) * (1 - (Math.min(high, Math.max(low, value)) - low) / (high - low));
  let path = "";
  points.forEach((point, index) => {
    if (point.value === null) return;
    const previous = points[index - 1];
    path += `${index === 0 || previous?.value === null ? "M" : "L"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`;
  });
  const hoveredPoint = hovered === null ? undefined : points[hovered];
  const onMove = useCallback(
    (event: ReactMouseEvent<SVGRectElement>) => {
      const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
      if (box === undefined || points.length === 0) return;
      const at = ((event.clientX - box.left) / box.width) * width;
      const index = Math.max(0, Math.min(points.length - 1, Math.round(((at - left) / (width - left - right)) * (points.length - 1))));
      const point = points[index];
      if (point === undefined) return;
      setHovered(index);
      tooltip.show(event, { title: point.label, rows: [{ label: valueLabel, value: point.value === null ? "no data" : format(point.value) }] });
    },
    [format, points, tooltip, valueLabel, width],
  );
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={label}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className={tick === low ? "us-axis" : "us-grid"} />
            <text x={left - 6} y={y(tick) + 4} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        ))}
        {points.length > 0 && (
          <>
            <text x={left} y={height - 4}>
              {points[0]?.label}
            </text>
            <text x={width - right} y={height - 4} textAnchor="end">
              {points.at(-1)?.label}
            </text>
          </>
        )}
        <path d={path} className="us-line" />
        {hoveredPoint !== undefined && hovered !== null && (
          <>
            <line x1={x(hovered)} x2={x(hovered)} y1={top} y2={height - bottom} className="us-axis" />
            {hoveredPoint.value !== null && <circle cx={x(hovered)} cy={y(hoveredPoint.value)} r={4} className="us-dot" />}
          </>
        )}
        <rect
          x={left}
          y={0}
          width={Math.max(0, width - left - right)}
          height={height}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => {
            setHovered(null);
            tooltip.hide();
          }}
        />
      </svg>
    </div>
  );
}

export interface HBar {
  key: string;
  label: string;
  value: number;
  muted?: boolean;
  tooltip: TooltipContent;
}

/** Ranked horizontal bars, direct-labeled with their value. */
export function HBarChart({ bars, format, label }: { bars: readonly HBar[]; format: (value: number) => string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(440);
  const tooltip = useTooltip();
  const row = 24;
  const left = 112;
  const right = 56;
  const height = Math.max(row, bars.length * row);
  const max = Math.max(0, ...bars.map((bar) => bar.value));
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={label}>
        {bars.map((bar, index) => {
          const top = index * row;
          const barWidth = max === 0 ? 3 : Math.max(3, ((width - left - right) * bar.value) / max);
          const name = bar.label.length > 16 ? `${bar.label.slice(0, 15)}…` : bar.label;
          return (
            <g key={bar.key}>
              <text x={left - 10} y={top + 15} textAnchor="end" className="us-label">
                {name}
              </text>
              <path d={roundedEnd(left, top + 5, barWidth, 14, 4)} fill={bar.muted === true ? "var(--other)" : "var(--series-1)"} />
              <text x={left + barWidth + 6} y={top + 15}>
                {format(bar.value)}
              </text>
              <rect
                x={0}
                y={top}
                width={width}
                height={row}
                fill="transparent"
                onMouseMove={(event) => tooltip.show(event, bar.tooltip)}
                onMouseLeave={() => tooltip.hide()}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export interface SparkPoint {
  ts: number;
  value: number;
}

/** A 0–100% line over time with a pointer readout, for subscription window history. */
export function PercentSpark({
  points,
  caption,
  formatTime,
}: {
  points: readonly SparkPoint[];
  caption: string;
  formatTime: (ts: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(300);
  const tooltip = useTooltip();
  const [hovered, setHovered] = useState<number | null>(null);
  const height = 70;
  const pad = 4;
  const top = 6;
  const bottom = 14;
  const first = points[0]?.ts ?? 0;
  const last = points.at(-1)?.ts ?? first + 1;
  const span = Math.max(1, last - first);
  const x = (ts: number) => pad + ((width - 2 * pad) * (ts - first)) / span;
  const y = (value: number) => top + (height - top - bottom) * (1 - Math.min(100, Math.max(0, value)) / 100);
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.ts).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
  const point = hovered === null ? undefined : points[hovered];
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={caption}>
        <line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} className="us-axis" />
        <line x1={pad} x2={width - pad} y1={y(100)} y2={y(100)} className="us-grid" strokeDasharray="3 3" />
        <text x={width - pad} y={y(100) + 11} textAnchor="end">
          100%
        </text>
        <text x={pad} y={height - 2}>
          {caption}
        </text>
        <path d={path} className="us-line" />
        {point !== undefined && <circle cx={x(point.ts)} cy={y(point.value)} r={4} className="us-dot" />}
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          onMouseMove={(event) => {
            const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
            if (box === undefined || points.length === 0) return;
            const at = first + (((event.clientX - box.left) / box.width) * width - pad) / (width - 2 * pad) * span;
            let nearest = 0;
            points.forEach((candidate, index) => {
              if (Math.abs(candidate.ts - at) < Math.abs((points[nearest]?.ts ?? 0) - at)) nearest = index;
            });
            const found = points[nearest];
            if (found === undefined) return;
            setHovered(nearest);
            tooltip.show(event, { title: formatTime(found.ts), rows: [{ label: "Used", value: `${Math.round(found.value)}%` }] });
          }}
          onMouseLeave={() => {
            setHovered(null);
            tooltip.hide();
          }}
        />
      </svg>
    </div>
  );
}

export interface ColumnPoint {
  key: string;
  value: number;
  tooltip: TooltipContent;
}

/** Single-series columns, such as cost per turn. */
export function ColumnChart({
  columns,
  format,
  label,
  firstLabel,
  lastLabel,
  height = 130,
}: {
  columns: readonly ColumnPoint[];
  format: (value: number) => string;
  label: string;
  firstLabel: string;
  lastLabel: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(420);
  const tooltip = useTooltip();
  const [hovered, setHovered] = useState<string | null>(null);
  const left = 44;
  const bottom = 18;
  const top = 4;
  const max = niceMax(Math.max(0, ...columns.map((column) => column.value)));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const slot = (width - left) / Math.max(1, columns.length);
  const columnWidth = Math.max(1, Math.min(14, slot - 2));
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={label}>
        {[0, 1, 2].map((step) => (
          <g key={step}>
            <line x1={left} x2={width} y1={y((max / 2) * step)} y2={y((max / 2) * step)} className={step === 0 ? "us-axis" : "us-grid"} />
            <text x={left - 6} y={y((max / 2) * step) + 4} textAnchor="end">
              {format((max / 2) * step)}
            </text>
          </g>
        ))}
        {columns.map((column, index) => {
          const x = left + index * slot + (slot - columnWidth) / 2;
          return (
            <g key={column.key}>
              <path
                d={roundedTop(x, y(column.value), columnWidth, y(0) - y(column.value), Math.min(3, columnWidth / 2))}
                fill="var(--series-1)"
                className={hovered === column.key ? "us-hot" : undefined}
              />
              <rect
                x={left + index * slot}
                y={top}
                width={slot}
                height={height - top - bottom}
                fill="transparent"
                onMouseMove={(event) => {
                  setHovered(column.key);
                  tooltip.show(event, column.tooltip);
                }}
                onMouseLeave={() => {
                  setHovered(null);
                  tooltip.hide();
                }}
              />
            </g>
          );
        })}
        <text x={left} y={height - 3}>
          {firstLabel}
        </text>
        <text x={width} y={height - 3} textAnchor="end">
          {lastLabel}
        </text>
      </svg>
    </div>
  );
}

export interface SplitPart {
  key: string;
  label: string;
  value: number;
  color: string;
  detail: string;
}

/** A 100% bar of parts with a keyed list below; tiny parts keep a visible sliver. */
export function SplitBar({ parts, label }: { parts: readonly SplitPart[]; label: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <>
      <div className="us-split" role="img" aria-label={label}>
        {parts
          .filter((part) => part.value > 0)
          .map((part) => (
            <div
              key={part.key}
              title={part.label}
              style={{ width: `${Math.max(1.5, total === 0 ? 0 : (part.value / total) * 100)}%`, background: `var(${part.color})` }}
            />
          ))}
      </div>
      <div className="us-kv">
        {parts.map((part) => (
          <KeyRow key={part.key} color={part.color} label={part.label} value={part.detail} />
        ))}
      </div>
    </>
  );
}

function KeyRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <>
      <i style={{ background: `var(${color})` }} />
      <span>{label}</span>
      <span className="us-v">{value}</span>
    </>
  );
}

export function Legend({ series }: { series: readonly Series[] }) {
  return (
    <div className="us-legend">
      {series.map((s) => (
        <span key={s.key}>
          <i style={{ background: `var(${s.color})` }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}
