import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { REALTIME_CHANNEL } from "./channel";
import type { PolicyStatus, rpcContract } from "./contract";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PolicyCard() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<PolicyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const refresh = useCallback(() => {
    rpc
      .call("status")
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [rpc]);

  useEffect(refresh, [refresh]);
  useRealtime(REALTIME_CHANNEL, refresh);

  const apply = () => {
    setApplying(true);
    rpc
      .call("apply")
      .then(setStatus)
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setApplying(false));
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        These settings are Cape security policy. The Cape policy plugin turns each one back if it changes, and
        checks again every minute. Ask Cape security before changing them.
      </p>
      {error !== null && <p className="text-destructive">{error}</p>}
      {status?.lastError != null && <p className="text-destructive">Last check failed: {status.lastError}</p>}
      <ul className="flex flex-col divide-y rounded-md border">
        {(status?.items ?? []).map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-4 px-3 py-2">
            <div className="flex flex-col">
              <span className="font-medium">{item.label}</span>
              <span className="text-muted-foreground text-xs">{item.reason}</span>
            </div>
            <span className={item.compliant ? "text-muted-foreground shrink-0" : "text-destructive shrink-0"}>
              {item.compliant ? item.current : `${item.current} (expected ${item.expected})`}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {status?.lastCheckedAt == null
            ? "Not checked yet"
            : `Last checked ${new Date(status.lastCheckedAt).toLocaleTimeString()}`}
        </span>
        <button
          type="button"
          className="rounded-md border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
          onClick={apply}
          disabled={applying}
        >
          {applying ? "Applying…" : "Apply now"}
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "cape-policy",
    title: "Cape policy",
    description: "Security settings enforced on Cape machines",
    component: PolicyCard,
  });
});
