import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { ColumnChart, SplitBar, type SplitPart } from "./charts";
import type { ModelKey, ThreadDetail, rpcContract } from "./contract";
import { formatPercent, formatTokens, formatUsd, providerLabel } from "./format";
import { modelLabel, totalTokens } from "./pricing";
import { errorMessage, modelColor, perTurnUsd, relativeTime, timeLabel, type Load } from "./view";

const MIX_PARTS = [
  { key: "cacheRead", label: "Cache read", color: "--series-1" },
  { key: "cacheWrite", label: "Cache write", color: "--series-2" },
  { key: "input", label: "Input", color: "--series-3" },
  { key: "output", label: "Output", color: "--series-4" },
] as const;

export function ThreadDrawer({ threadKey, modelKeys, onClose }: { threadKey: string; modelKeys: readonly ModelKey[]; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<Load<ThreadDetail>>({ status: "loading" });
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    rpc
      .call("thread", { key: threadKey })
      .then((value) => live && setState({ status: "ready", value }))
      .catch((error: unknown) => live && setState({ status: "error", message: errorMessage(error) }));
    return () => {
      live = false;
    };
  }, [rpc, threadKey]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const now = Date.now();
  return (
    <aside className="us-drawer" aria-label="Thread usage">
      <button ref={closeRef} type="button" className="us-close" onClick={onClose}>
        Esc
      </button>
      {state.status === "loading" && <div className="us-muted">Loading…</div>}
      {state.status === "error" && <div className="us-muted">{state.message}</div>}
      {state.status === "ready" && (
        <DrawerBody detail={state.value} modelKeys={modelKeys} now={now} onOpen={(threadId) => navigate.toThread(threadId)} />
      )}
    </aside>
  );
}

function drawerSources(detail: ThreadDetail): string {
  const sessions = detail.sessionIds.map((id) => id.slice(0, 8)).join(", ");
  if (detail.threadId === null) return `Claude Code transcript of session ${sessions}`;
  if (detail.sessionIds.length === 0) return "bb usage ledger";
  return `bb usage ledger and the Claude Code transcript of session ${sessions}`;
}

function DrawerBody({
  detail,
  modelKeys,
  now,
  onOpen,
}: {
  detail: ThreadDetail;
  modelKeys: readonly ModelKey[];
  now: number;
  onOpen: (threadId: string) => void;
}) {
  const perTurn = perTurnUsd(detail.totals);
  const models: SplitPart[] = detail.models.map((model) => ({
    key: model.model,
    label: modelLabel(model.model),
    value: totalTokens(model),
    color: modelColor(model.model, modelKeys),
    detail: `${formatUsd(model.costUsd)} · ${formatTokens(totalTokens(model))}`,
  }));
  const mixTotal = detail.totals.tokens;
  const mix: SplitPart[] = MIX_PARTS.map((part) => ({
    ...part,
    value: detail.totals[part.key],
    detail: `${formatTokens(detail.totals[part.key])} · ${formatPercent(mixTotal === 0 ? null : detail.totals[part.key] / mixTotal)}`,
  }));
  const meta = [
    detail.project,
    providerLabel(detail.provider),
    detail.threadId ?? "outside bb",
    `${detail.totals.turns.toLocaleString()} turns`,
    detail.lastTs === null ? null : `last active ${relativeTime(detail.lastTs, now)}`,
  ].filter(Boolean);
  const firstTurn = detail.turns[0];
  const lastTurn = detail.turns.at(-1);
  return (
    <>
      <h2>{detail.title}</h2>
      <div className="us-muted us-small">{meta.join(" · ")}</div>
      <div className="us-mini">
        {[
          ["Cost", formatUsd(detail.totals.costUsd)],
          ["Tokens", formatTokens(detail.totals.tokens)],
          ["Per turn", perTurn === null ? "–" : formatUsd(perTurn)],
        ].map(([label, value]) => (
          <div key={label} className="us-card us-tile">
            <div className="us-label">{label}</div>
            <div className="us-value">{value}</div>
          </div>
        ))}
      </div>
      <section>
        <h4>Cost per turn</h4>
        {firstTurn === undefined || lastTurn === undefined ? (
          <div className="us-muted us-small">No turns recorded</div>
        ) : (
          <ColumnChart
            label="Cost per turn, column chart"
            format={formatUsd}
            firstLabel={`Turn ${firstTurn.index}`}
            lastLabel={`Turn ${lastTurn.index}`}
            columns={detail.turns.map((turn) => ({
              key: String(turn.index),
              value: turn.costUsd,
              tooltip: {
                title: `Turn ${turn.index} · ${timeLabel(turn.ts)}`,
                rows: [
                  { label: "Cost", value: formatUsd(turn.costUsd) },
                  { label: "Tokens", value: formatTokens(turn.tokens) },
                ],
              },
            }))}
          />
        )}
      </section>
      <section>
        <h4>Models</h4>
        <SplitBar parts={models} label="Tokens by model" />
      </section>
      <section>
        <h4>Token mix</h4>
        <SplitBar parts={mix} label="Tokens by type" />
      </section>
      <div className="us-note">
        Sources: {drawerSources(detail)}.{" "}
        {detail.threadId !== null && (
          <button type="button" className="us-link" onClick={() => onOpen(detail.threadId ?? "")}>
            Open thread →
          </button>
        )}
      </div>
    </>
  );
}
