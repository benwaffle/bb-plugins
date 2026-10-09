import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import policyJson from "./policy.json" with { type: "json" };

const entrySchema = z
  .object({ pluginId: z.string().min(1), label: z.string(), reason: z.string() })
  .strict();

export const policySchema = z
  .object({
    version: z.literal(1),
    signedOut: entrySchema,
    disabledPlugins: z.array(entrySchema),
    generalSettings: z.array(
      z
        .object({
          key: z.literal("telemetryEnabled"),
          value: z.boolean(),
          label: z.string(),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;

export const CAPE_POLICY: Policy = policySchema.parse(policyJson);

export const AI_TASKS = ["thread-title", "commit-message", "voice"] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** bb-account's RPC methods (plugins/bb-account/src/contract.ts upstream). */
export const ACCOUNT_STATUS_METHOD = "bb-account.v1.status";
export const ACCOUNT_SIGN_OUT_METHOD = "signOut";

const accountStatusSchema = z.looseObject({ state: z.string() });
const signOutResultSchema = z.looseObject({
  revocation: z.string(),
  status: accountStatusSchema,
  message: z.string().optional(),
});

type Sdk = BbPluginApi["sdk"];
type AiSelection = Awaited<ReturnType<Sdk["system"]["aiServices"]>>["selections"][AiTask];
type GeneralSettings = Awaited<ReturnType<Sdk["system"]["config"]>>["generalSettings"];

/**
 * Remembers when bb-account was last confirmed signed out. While the plugin
 * is disabled its stored credential cannot be read, so this is how a pass
 * knows a disabled bb-account holds no credential.
 */
export interface SignOutRecord {
  confirmedAt(): Promise<number | null>;
  confirm(at: number): Promise<void>;
}

/**
 * How long a sign-out confirmation stands for a disabled bb-account. A user
 * can enable it, sign in, and disable it again between two checks, so a
 * disabled bb-account is enabled and checked again once this has passed.
 */
export const SIGN_OUT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface PolicyItem {
  /** Stable id: `account:<id>`, `plugin:<id>`, `ai:<task>`, or `setting:<key>`. */
  id: string;
  label: string;
  reason: string;
  /** What the policy requires, in words. */
  expected: string;
  /** What bb reports now, in words. */
  current: string;
  compliant: boolean;
}

export interface PolicySnapshot {
  items: PolicyItem[];
  compliant: boolean;
}

export interface Revert {
  id: string;
  from: string;
  to: string;
}

interface Observed {
  plugins: Map<string, boolean>;
  accountState: string | null;
  signOutConfirmedAt: number | null;
  selections: Record<AiTask, AiSelection>;
  generalSettings: GeneralSettings;
  now: number;
}

/** bb-account's state, or `unreadable (<error>)` when its status call fails. */
async function readAccountState(sdk: Sdk, pluginId: string): Promise<string> {
  try {
    return await accountState(sdk, pluginId);
  } catch (error) {
    return `unreadable (${errorMessage(error)})`;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function accountState(sdk: Sdk, pluginId: string): Promise<string> {
  const status = await sdk.plugins.callRpc({
    pluginId,
    method: ACCOUNT_STATUS_METHOD,
    input: null,
    outputSchema: accountStatusSchema,
  });
  return status.state;
}

async function observe(sdk: Sdk, policy: Policy, record: SignOutRecord): Promise<Observed> {
  const [plugins, aiServices, config, signOutConfirmedAt] = await Promise.all([
    sdk.plugins.list(),
    sdk.system.aiServices(),
    sdk.system.config(),
    record.confirmedAt(),
  ]);
  const enabled = new Map(plugins.plugins.map((plugin) => [plugin.id, plugin.enabled]));
  const accountPluginId = policy.signedOut.pluginId;
  return {
    plugins: enabled,
    accountState: enabled.get(accountPluginId) === true ? await readAccountState(sdk, accountPluginId) : null,
    signOutConfirmedAt,
    selections: aiServices.selections,
    generalSettings: config.generalSettings,
    now: Date.now(),
  };
}

function describeSelection(selection: AiSelection): string {
  return selection.mode === "service" ? `routed to ${selection.pluginId}` : selection.mode;
}

/** An AI task breaks policy when it is pinned to a plugin the policy disables. */
function routesToBlockedPlugin(policy: Policy, selection: AiSelection): boolean {
  return (
    selection.mode === "service" &&
    policy.disabledPlugins.some((entry) => entry.pluginId === selection.pluginId)
  );
}

/** The last sign-out confirmation, or null when there is none from the last day. */
function freshSignOutConfirmation(observed: Observed): number | null {
  const at = observed.signOutConfirmedAt;
  return at !== null && observed.now - at < SIGN_OUT_CONFIRMATION_TTL_MS ? at : null;
}

function accountItem(policy: Policy, observed: Observed): PolicyItem {
  const { pluginId, label, reason } = policy.signedOut;
  const base = { id: `account:${pluginId}`, label, reason, expected: "signed-out" };
  const installed = observed.plugins.has(pluginId);
  if (observed.accountState !== null) {
    return { ...base, current: observed.accountState, compliant: observed.accountState === "signed-out" };
  }
  if (!installed) return { ...base, current: "not installed", compliant: true };
  const confirmedAt = freshSignOutConfirmation(observed);
  if (confirmedAt !== null) {
    const at = new Date(confirmedAt).toISOString();
    return { ...base, current: `signed-out (confirmed ${at}, plugin disabled since)`, compliant: true };
  }
  return { ...base, current: "unknown (plugin disabled, sign-out not confirmed in the last day)", compliant: false };
}

function evaluate(policy: Policy, observed: Observed): PolicyItem[] {
  const pluginItems = policy.disabledPlugins.map((entry): PolicyItem => {
    const enabled = observed.plugins.get(entry.pluginId);
    return {
      id: `plugin:${entry.pluginId}`,
      label: entry.label,
      reason: entry.reason,
      expected: "disabled",
      current: enabled === undefined ? "not installed" : enabled ? "enabled" : "disabled",
      compliant: enabled !== true,
    };
  });
  const blocked = policy.disabledPlugins.map((entry) => entry.pluginId).join(", ");
  const aiItems = AI_TASKS.map((task): PolicyItem => {
    const selection = observed.selections[task];
    return {
      id: `ai:${task}`,
      label: `AI ${task}`,
      reason: `The ${task} helper must not route to ${blocked}.`,
      expected: `not routed to ${blocked}`,
      current: describeSelection(selection),
      compliant: !routesToBlockedPlugin(policy, selection),
    };
  });
  const settingItems = policy.generalSettings.map((entry): PolicyItem => {
    const value = observed.generalSettings[entry.key];
    return {
      id: `setting:${entry.key}`,
      label: entry.label,
      reason: entry.reason,
      expected: String(entry.value),
      current: String(value),
      compliant: value === entry.value,
    };
  });
  return [accountItem(policy, observed), ...pluginItems, ...aiItems, ...settingItems];
}

function snapshotOf(items: PolicyItem[]): PolicySnapshot {
  return { items, compliant: items.every((item) => item.compliant) };
}

export async function readPolicy(sdk: Sdk, policy: Policy, record: SignOutRecord): Promise<PolicySnapshot> {
  return snapshotOf(evaluate(policy, await observe(sdk, policy, record)));
}

async function signOut(sdk: Sdk, pluginId: string): Promise<void> {
  const result = await sdk.plugins.callRpc({
    pluginId,
    method: ACCOUNT_SIGN_OUT_METHOD,
    input: null,
    outputSchema: signOutResultSchema,
  });
  // "failed" means getbb.app did not confirm the revocation; bb-account
  // still drops the credential locally, which the status check verifies.
  if (result.status.state !== "signed-out") {
    throw new Error(`${pluginId} is still ${result.status.state} after sign-out`);
  }
}

/**
 * Sign bb-account out. A disabled bb-account that has never been confirmed
 * signed out may still hold a credential in its storage, so it is enabled
 * just long enough to sign out and disabled again.
 */
async function enforceSignedOut(
  sdk: Sdk,
  policy: Policy,
  observed: Observed,
  record: SignOutRecord,
  reverts: Revert[],
): Promise<void> {
  const { pluginId } = policy.signedOut;
  const id = `account:${pluginId}`;
  if (observed.accountState !== null) {
    if (observed.accountState !== "signed-out") {
      await signOut(sdk, pluginId);
      reverts.push({ id, from: observed.accountState, to: "signed-out" });
    }
    await record.confirm(Date.now());
    return;
  }
  if (!observed.plugins.has(pluginId) || freshSignOutConfirmation(observed) !== null) return;

  await sdk.plugins.enable({ pluginId });
  try {
    const state = await accountState(sdk, pluginId);
    if (state !== "signed-out") {
      await signOut(sdk, pluginId);
      reverts.push({ id, from: state, to: "signed-out" });
    }
  } finally {
    await sdk.plugins.disable({ pluginId });
  }
  await record.confirm(Date.now());
}

export interface ApplyResult {
  reverts: Revert[];
  /** One message per step that failed; the other steps still ran. */
  errors: string[];
  snapshot: PolicySnapshot;
}

/**
 * Bring bb in line with the policy and report each change made. Sign-out
 * runs first because it needs bb-account enabled; plugins are disabled next
 * so a disabled bb-ai cannot be picked again by an `automatic` AI selection.
 * Each step runs even when an earlier one fails, so getbb.app being down
 * during sign-out does not leave connect or telemetry on.
 */
export async function applyPolicy(sdk: Sdk, policy: Policy, record: SignOutRecord): Promise<ApplyResult> {
  const observed = await observe(sdk, policy, record);
  const reverts: Revert[] = [];
  const errors: string[] = [];

  async function step(id: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      errors.push(`${id}: ${errorMessage(error)}`);
    }
  }

  await step(`account:${policy.signedOut.pluginId}`, () =>
    enforceSignedOut(sdk, policy, observed, record, reverts),
  );

  for (const entry of policy.disabledPlugins) {
    if (observed.plugins.get(entry.pluginId) !== true) continue;
    await step(`plugin:${entry.pluginId}`, async () => {
      await sdk.plugins.disable({ pluginId: entry.pluginId });
      reverts.push({ id: `plugin:${entry.pluginId}`, from: "enabled", to: "disabled" });
    });
  }

  for (const task of AI_TASKS) {
    const selection = observed.selections[task];
    if (!routesToBlockedPlugin(policy, selection)) continue;
    await step(`ai:${task}`, async () => {
      await sdk.system.setAiServiceSelection({ task, selection: { mode: "off" } });
      reverts.push({ id: `ai:${task}`, from: describeSelection(selection), to: "off" });
    });
  }

  const settingDrift = policy.generalSettings.filter(
    (entry) => observed.generalSettings[entry.key] !== entry.value,
  );
  if (settingDrift.length > 0) {
    await step("settings", async () => {
      const next = { ...observed.generalSettings };
      for (const entry of settingDrift) next[entry.key] = entry.value;
      await sdk.system.updateGeneralSettings(next);
      for (const entry of settingDrift) {
        reverts.push({
          id: `setting:${entry.key}`,
          from: String(observed.generalSettings[entry.key]),
          to: String(entry.value),
        });
      }
    });
  }

  return { reverts, errors, snapshot: await readPolicy(sdk, policy, record) };
}
