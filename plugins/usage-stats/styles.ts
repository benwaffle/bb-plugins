/**
 * Chart tokens, from the dataviz reference palette: the first four
 * categorical slots validate adjacent-pair CVD separation in both modes.
 * Light slots 3 and 4 sit below 3:1 on the light surface, so the main chart
 * keeps a table view.
 */
export const STYLES = `
.us-root { --font: system-ui, -apple-system, "Segoe UI", sans-serif; position: relative; height: 100%; display: flex; font: 13px/1.45 var(--font); color: var(--text-primary); background: var(--page); }
.us-root[data-theme="light"] { color-scheme: light; --page: #f9f9f7; --surface-1: #fcfcfb; --surface-2: #f0efec; --raised: #ffffff;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7;
  --ring: rgba(11,11,11,0.10); --wash: rgba(11,11,11,0.04); --pressed: #e9e8e3;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100; --other: #a9a8a2;
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b; --shadow: 0 8px 24px rgba(0,0,0,.12); }
.us-root[data-theme="dark"] { color-scheme: dark; --page: #0d0d0d; --surface-1: #1a1a19; --surface-2: #232322; --raised: #262625;
  --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #898781; --grid: #2c2c2a; --axis: #383835;
  --ring: rgba(255,255,255,0.10); --wash: rgba(255,255,255,0.05); --pressed: #2e2e2c;
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500; --other: #6b6a65;
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b; --shadow: 0 8px 24px rgba(0,0,0,.4); }
.us-root button { font: inherit; color: inherit; }
.us-scroll { flex: 1; min-width: 0; overflow: auto; }
.us-main { padding: 18px 24px 40px; max-width: 1240px; }
.us-topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.us-topbar h1 { font-size: 18px; margin: 0 12px 0 0; font-weight: 600; }
.us-seg { display: inline-flex; background: var(--surface-1); border: 1px solid var(--ring); border-radius: 8px; padding: 2px; }
.us-seg button { border: 0; background: transparent; padding: 4px 10px; border-radius: 6px; color: var(--text-secondary); cursor: pointer; }
.us-seg button[aria-pressed="true"] { background: var(--pressed); color: var(--text-primary); }
.us-seg button:hover { background: var(--wash); }
.us-spacer { flex: 1; }
.us-muted { color: var(--text-muted); }
.us-small { font-size: 12px; }
.us-grid12 { display: grid; gap: 12px; grid-template-columns: repeat(12, minmax(0, 1fr)); }
.us-card { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.us-card h2 { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
.us-sub { color: var(--text-muted); font-size: 12px; margin-bottom: 10px; }
.us-card-head { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.us-card-head > div:first-child { flex: 1; }
.us-s3 { grid-column: span 3; } .us-s4 { grid-column: span 4; } .us-s5 { grid-column: span 5; } .us-s8 { grid-column: span 8; } .us-s12 { grid-column: span 12; }
@media (max-width: 1100px) { .us-s3 { grid-column: span 6; } .us-s4, .us-s5, .us-s8 { grid-column: span 12; } }
.us-tile .us-label { color: var(--text-secondary); font-size: 12px; }
.us-tile .us-value { font-size: 26px; font-weight: 600; margin: 2px 0; letter-spacing: -0.01em; }
.us-tile .us-delta { font-size: 12px; color: var(--text-muted); }
.us-badge { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--ring); color: var(--text-muted); margin-left: 6px; vertical-align: 1px; cursor: help; }
.us-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin: 4px 0 6px; }
.us-legend i, .us-kv i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.us-root svg { display: block; width: 100%; overflow: visible; }
.us-root svg text { fill: var(--text-muted); font: 11px var(--font); font-variant-numeric: tabular-nums; }
.us-root svg text.us-label { fill: var(--text-secondary); }
.us-grid { stroke: var(--grid); stroke-width: 1; }
.us-axis { stroke: var(--axis); stroke-width: 1; }
.us-line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; }
.us-dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
.us-hot { filter: brightness(1.15); }
.us-tip { position: fixed; pointer-events: none; background: var(--raised); border: 1px solid var(--ring); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: var(--shadow); min-width: 170px; transition: opacity .08s; z-index: 50; color: var(--text-primary); }
.us-tip-title { font-weight: 600; margin-bottom: 4px; }
.us-tip-row { display: flex; justify-content: space-between; gap: 14px; color: var(--text-secondary); }
.us-tip-row span:last-child { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.us-tip-row i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
.us-tip-total { border-top: 1px solid var(--grid); margin-top: 4px; padding-top: 4px; }
.us-meter { margin: 10px 0 14px; }
.us-meter-row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px; }
.us-meter-row span:first-child { color: var(--text-secondary); }
.us-bar { height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
.us-fill { height: 100%; border-radius: 4px; }
.us-meter-foot { font-size: 11px; color: var(--text-muted); margin-top: 4px; display: flex; justify-content: space-between; }
.us-root table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.us-root th { text-align: left; font-weight: 500; font-size: 11px; color: var(--text-muted); padding: 6px 8px; border-bottom: 1px solid var(--grid); }
.us-root td { padding: 7px 8px; border-bottom: 1px solid var(--grid); color: var(--text-secondary); white-space: nowrap; }
.us-root .us-num { text-align: right; }
.us-click { cursor: pointer; }
.us-click:hover td { background: var(--wash); }
.us-click:focus-visible { outline: 2px solid var(--series-1); outline-offset: -2px; }
.us-sel td { background: color-mix(in srgb, var(--series-1) 12%, transparent); }
.us-name { color: var(--text-primary); max-width: 280px; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
.us-ibar { display: inline-block; height: 6px; border-radius: 3px; background: var(--series-1); vertical-align: middle; margin-right: 8px; }
.us-pill { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--surface-2); color: var(--text-secondary); margin-left: 6px; }
.us-split { display: flex; height: 14px; border-radius: 4px; overflow: hidden; gap: 2px; margin: 10px 0 8px; }
.us-split div { height: 100%; }
.us-kv { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 10px; font-size: 12px; align-items: center; }
.us-v { font-variant-numeric: tabular-nums; color: var(--text-primary); text-align: right; }
.us-note { font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--grid); padding-top: 10px; margin-top: 12px; }
.us-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(460px, 100%); background: var(--surface-1); border-left: 1px solid var(--ring); box-shadow: var(--shadow); padding: 18px 20px; overflow-y: auto; z-index: 20; }
.us-drawer h2 { margin: 0; font-size: 15px; padding-right: 48px; }
.us-close { float: right; border: 0; background: var(--surface-2); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.us-drawer section { margin-top: 18px; }
.us-drawer h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.us-mini { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.us-mini .us-card { padding: 10px 12px; }
.us-mini .us-value { font-size: 20px; }
.us-link { color: var(--series-1); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: none; }
.us-empty { padding: 40px 0; color: var(--text-muted); text-align: center; }
.us-side-root { display: block; height: auto; background: transparent; }
.us-side { padding: 8px; font-size: 13px; }
.us-side h3 { margin: 4px 8px 8px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted); }
.us-side button { display: flex; width: 100%; justify-content: space-between; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }
.us-side button[aria-current="page"] { background: var(--wash); color: var(--text-primary); }
.us-side button span:last-child { color: var(--text-muted); font-variant-numeric: tabular-nums; }
`;
