import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { REALTIME_CHANNEL, rpcContract, type PolicyStatus } from "./contract.js";
import {
  CAPE_POLICY,
  applyPolicy,
  errorMessage,
  readPolicy,
  type Policy,
  type PolicyItem,
  type SignOutRecord,
} from "./policy.js";

export { rpcContract };

export const RECHECK_INTERVAL_MS = 60_000;

function formatItem(item: PolicyItem): string {
  return `${item.compliant ? "ok" : "VIOLATION"}\t${item.id}\t${item.current}\t(expected ${item.expected})`;
}

function formatStatus(status: PolicyStatus): string {
  const header = status.compliant ? "Cape policy: compliant" : "Cape policy: NOT compliant";
  const error = status.lastError === null ? [] : [`last error: ${status.lastError}`];
  return `${[header, ...error, ...status.items.map(formatItem)].join("\n")}\n`;
}

function explain(policy: Policy): string {
  const lines = [
    "Cape security policy for bb. This plugin enforces it on load, whenever bb",
    `reports a settings or plugin change, and every ${RECHECK_INTERVAL_MS / 1000}s. Changes that break it are reverted.`,
    "",
    `- ${policy.signedOut.label} (${policy.signedOut.pluginId}) stays signed out: ${policy.signedOut.reason} A disabled ${policy.signedOut.pluginId} is enabled briefly once a day to confirm it holds no credential.`,
    ...policy.disabledPlugins.map((entry) => `- ${entry.label} (${entry.pluginId}) stays disabled: ${entry.reason}`),
    "- No AI helper task (thread titles, commit messages, voice) may be routed to a disabled plugin; such a selection is set to off.",
    ...policy.generalSettings.map((entry) => `- ${entry.label} (${entry.key}) stays ${String(entry.value)}: ${entry.reason}`),
    "",
    "Questions go to Cape security.",
  ];
  return `${lines.join("\n")}\n`;
}

const SIGN_OUT_CONFIRMED_KEY = "signOutConfirmedAt";

export function createSignOutRecord(kv: BbPluginApi["storage"]["kv"]): SignOutRecord {
  return {
    confirmedAt: async () => (await kv.get<number>(SIGN_OUT_CONFIRMED_KEY)) ?? null,
    confirm: (at) => kv.set(SIGN_OUT_CONFIRMED_KEY, at),
  };
}

export function createEnforcer(bb: BbPluginApi, policy: Policy, record: SignOutRecord) {
  let status: PolicyStatus = { items: [], compliant: false, lastCheckedAt: null, lastError: null };
  let running: Promise<PolicyStatus> | null = null;
  let rerun = false;

  async function enforceOnce(trigger: string): Promise<PolicyStatus> {
    try {
      const { reverts, errors, snapshot } = await applyPolicy(bb.sdk, policy, record);
      for (const revert of reverts) {
        bb.log.warn(`reverted ${revert.id}: ${revert.from} -> ${revert.to} (trigger: ${trigger})`);
      }
      for (const error of errors) {
        bb.log.error(`could not enforce ${error} (trigger: ${trigger})`);
      }
      status = {
        ...snapshot,
        compliant: snapshot.compliant && errors.length === 0,
        lastCheckedAt: Date.now(),
        lastError: errors.length === 0 ? null : errors.join("; "),
      };
    } catch (error) {
      bb.log.error(`could not apply Cape policy (trigger: ${trigger}): ${errorMessage(error)}`);
      status = { ...status, compliant: false, lastCheckedAt: Date.now(), lastError: errorMessage(error) };
    }
    bb.realtime.publish(REALTIME_CHANNEL, null);
    return status;
  }

  /**
   * One pass at a time. A trigger that lands mid-pass schedules one more
   * pass, so a change made while the policy applies is still caught.
   */
  function enforce(trigger: string): Promise<PolicyStatus> {
    if (running !== null) {
      rerun = true;
      return running;
    }
    running = (async () => {
      let result = await enforceOnce(trigger);
      while (rerun) {
        rerun = false;
        result = await enforceOnce(`${trigger} (rerun)`);
      }
      running = null;
      return result;
    })();
    return running;
  }

  return {
    enforce,
    current: (): PolicyStatus => status,
  };
}

export default function plugin(bb: BbPluginApi): void {
  const record = createSignOutRecord(bb.storage.kv);
  const enforcer = createEnforcer(bb, CAPE_POLICY, record);

  bb.background.service("enforcer", {
    async start(signal) {
      const unsubscribers = [
        bb.sdk.subscribe({
          event: "system:config-changed",
          callback: () => void enforcer.enforce("settings changed"),
        }),
        bb.sdk.subscribe({
          event: "system:changed",
          callback: () => void enforcer.enforce("system changed"),
        }),
      ];
      const timer = setInterval(() => void enforcer.enforce("periodic check"), RECHECK_INTERVAL_MS);
      await enforcer.enforce("plugin loaded");
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      clearInterval(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  });

  bb.rpc.register(rpcContract, {
    status: async () => enforcer.current(),
    apply: () => enforcer.enforce("settings card"),
  });

  const jsonOption = { json: { type: "boolean", description: "Print the result as JSON" } } as const;
  const print = (status: PolicyStatus, json: boolean | undefined) => ({
    exitCode: status.compliant ? 0 : 1,
    stdout: json ? `${JSON.stringify(status)}\n` : formatStatus(status),
  });

  bb.cli.register(
    defineCli({
      name: "cape-policy",
      summary: "Show, apply, or explain the Cape security policy for bb",
      commands: {
        status: cliCommand({
          summary: "Check every enforced item against bb's current state; exits 1 when any is out of policy",
          options: jsonOption,
          async run(input) {
            const snapshot = await readPolicy(bb.sdk, CAPE_POLICY, record);
            const current = enforcer.current();
            return print(
              { ...snapshot, lastCheckedAt: current.lastCheckedAt, lastError: current.lastError },
              input.options.json,
            );
          },
        }),
        apply: cliCommand({
          summary: "Apply the policy now and print the result",
          options: jsonOption,
          async run(input) {
            return print(await enforcer.enforce("cli apply"), input.options.json);
          },
        }),
        explain: cliCommand({
          summary: "Explain what the policy enforces and why",
          async run() {
            return { exitCode: 0, stdout: explain(CAPE_POLICY) };
          },
        }),
      },
    }),
  );
}
