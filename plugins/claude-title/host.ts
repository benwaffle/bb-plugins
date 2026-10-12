import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  experimental_defineHostEntry,
  type ExperimentalHostPaths,
} from "@get-bb/plugin-sdk/host";
import {
  claudeHostContract,
  type ClaudeFailureCode,
  type ClaudeStatus,
  type CompleteInput,
  type CompleteOutput,
  type Login,
} from "./contract.js";

const CLAUDE_NAME = "claude";
const LOGGED_IN_TTL_MS = 10 * 60_000;
// A logged-out result is rechecked soon so `claude auth login` shows up
// without waiting out the logged-in TTL.
const NOT_LOGGED_IN_TTL_MS = 30_000;
// bb gives a service's status two seconds in total.
const AUTH_STATUS_TIMEOUT_MS = 1_500;
const STDERR_TAIL_CHARS = 400;
const INSTALL_HINT =
  "Install Claude Code (https://claude.com/claude-code) or set the claude path in the plugin settings.";

export interface ClaudeHostDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly fallbackBinDirs: readonly string[];
  now(): number;
}

interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: string | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

class ClaudeFailure extends Error {
  readonly code: ClaudeFailureCode;

  constructor(code: ClaudeFailureCode, message: string) {
    super(message);
    this.name = "ClaudeFailure";
    this.code = code;
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function resolveClaude(
  deps: Pick<ClaudeHostDependencies, "env" | "fallbackBinDirs">,
  override: string | null,
): Promise<string | null> {
  if (override !== null) {
    return (await isExecutable(override)) ? override : null;
  }
  const fromPath = (deps.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  for (const directory of new Set([...fromPath, ...deps.fallbackBinDirs])) {
    const candidate = path.join(directory, CLAUDE_NAME);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * The environment claude runs with: the host's own, minus the variables that
 * make claude believe it is nested inside another Claude Code session, and
 * without update checks and telemetry, which only add startup time.
 */
function claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CLAUDECODE: _nested, CLAUDE_CODE_ENTRYPOINT: _entry, ...rest } = env;
  return { ...rest, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

/**
 * Runs a command in its own process group. A timeout or abort kills the whole
 * group, so hooks or other children claude started die with it, and settles
 * at once instead of waiting for those children to close the pipes.
 */
function runCommand(request: CommandRequest): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // claude may exit before reading its input; that surfaces as EPIPE here
    // and as a non-zero exit below.
    child.stdin.on("error", () => {});
    child.stdin.end(request.stdin ?? "");
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        aborted,
      });
    };
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      settle(null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, request.timeoutMs);
    timer.unref();
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    if (request.signal?.aborted) onAbort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", settle);
  });
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > STDERR_TAIL_CHARS
    ? trimmed.slice(trimmed.length - STDERR_TAIL_CHARS)
    : trimmed;
}

export function systemPrompt(maxTitleLength: number): string {
  return [
    "You write one short piece of text for a developer tool, such as a thread title or a git commit message.",
    "Follow the instructions in the user's message and reply with only the requested text, on a single line, with no preamble, quotes, or explanation.",
    `A title stays under ${maxTitleLength} characters, has no trailing period, and is in the same language as the task it names.`,
  ].join(" ");
}

export function claudeArgs(input: {
  model: string;
  maxTitleLength: number;
}): string[] {
  return [
    "--print",
    "--model",
    input.model,
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--settings",
    JSON.stringify({ alwaysThinkingEnabled: false }),
    "--system-prompt",
    systemPrompt(input.maxTitleLength),
  ];
}

interface PrintResult {
  readonly isError: boolean;
  readonly text: string;
}

function parsePrintResult(stdout: string): PrintResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { is_error: isError, result } = parsed as Record<string, unknown>;
  return {
    isError: isError === true,
    text: typeof result === "string" ? result : "",
  };
}

export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function describeFailure(result: CommandResult, reply: PrintResult | null): string {
  const exit =
    result.exitCode === null ? "was killed" : `exited with ${result.exitCode}`;
  const detail = firstLine(reply?.text ?? "") || stderrTail(result.stderr);
  return detail.length > 0 ? `claude ${exit}: ${detail}` : `claude ${exit}`;
}

async function requireClaude(
  deps: ClaudeHostDependencies,
  override: string | null,
): Promise<string> {
  const claude = await resolveClaude(deps, override);
  if (claude === null) {
    throw new ClaudeFailure(
      "not_found",
      override === null
        ? `claude was not found on this host. ${INSTALL_HINT}`
        : `${override} is not an executable file. ${INSTALL_HINT}`,
    );
  }
  return claude;
}

/**
 * Runs claude from an empty directory so no project CLAUDE.md, settings, or
 * MCP configuration applies, with every tool and extended thinking off.
 */
async function complete(
  deps: ClaudeHostDependencies,
  paths: ExperimentalHostPaths,
  input: CompleteInput,
  signal: AbortSignal,
): Promise<Extract<CompleteOutput, { ok: true }>> {
  const claude = await requireClaude(deps, input.claudePath);
  await mkdir(paths.tempDir, { recursive: true });
  const workDir = await mkdtemp(path.join(paths.tempDir, "complete-"));
  const startedAt = deps.now();
  try {
    const result = await runCommand({
      command: claude,
      args: claudeArgs(input),
      cwd: workDir,
      env: claudeEnv(deps.env),
      stdin: input.prompt,
      timeoutMs: input.timeoutMs,
      signal,
    });
    if (result.aborted) {
      throw new ClaudeFailure("request_failed", "The request was cancelled");
    }
    if (result.timedOut) {
      throw new ClaudeFailure(
        "timeout",
        `claude did not answer within ${input.timeoutMs}ms`,
      );
    }
    const reply = parsePrintResult(result.stdout);
    if (result.exitCode !== 0 || reply === null || reply.isError) {
      throw new ClaudeFailure("request_failed", describeFailure(result, reply));
    }
    const text = firstLine(reply.text);
    if (text.length === 0) {
      throw new ClaudeFailure("request_failed", "claude returned an empty reply");
    }
    return { ok: true, text, durationMs: deps.now() - startedAt };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function toFailure(error: unknown): Extract<CompleteOutput, { ok: false }> {
  if (error instanceof ClaudeFailure) {
    return { ok: false, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: "request_failed", message };
}

/**
 * Reads only `loggedIn` from `claude auth status --json`; the rest of its
 * output (account email, organization) is never stored or returned.
 */
async function checkLogin(
  deps: ClaudeHostDependencies,
  claude: string,
  cwd: string,
): Promise<Login> {
  let result: CommandResult;
  try {
    result = await runCommand({
      command: claude,
      args: ["auth", "status", "--json"],
      cwd,
      env: claudeEnv(deps.env),
      stdin: null,
      timeoutMs: AUTH_STATUS_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unknown", message: `claude auth status failed: ${message}` };
  }
  if (result.timedOut) {
    return {
      state: "unknown",
      message: `claude auth status did not answer within ${AUTH_STATUS_TIMEOUT_MS}ms`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      state: "unknown",
      message: `claude auth status printed no JSON (exit ${result.exitCode ?? "killed"})`,
    };
  }
  const loggedIn = (parsed as { loggedIn?: unknown } | null)?.loggedIn;
  if (typeof loggedIn !== "boolean") {
    return {
      state: "unknown",
      message: "claude auth status did not report loggedIn",
    };
  }
  return { state: loggedIn ? "logged-in" : "logged-out" };
}

interface CachedLogin {
  readonly login: Login;
  readonly checkedAt: number;
}

class LoginCache {
  private readonly entries = new Map<string, CachedLogin>();
  private readonly inFlight = new Map<string, Promise<Login>>();

  constructor(private readonly deps: ClaudeHostDependencies) {}

  get(claude: string, cwd: string, refresh: boolean): Promise<Login> {
    const cached = this.entries.get(claude);
    if (!refresh && cached !== undefined && this.isFresh(cached)) {
      return Promise.resolve(cached.login);
    }
    const pending = this.inFlight.get(claude);
    if (pending !== undefined) return pending;
    const request = checkLogin(this.deps, claude, cwd)
      .then((login) => {
        this.entries.set(claude, { login, checkedAt: this.deps.now() });
        return login;
      })
      .finally(() => this.inFlight.delete(claude));
    this.inFlight.set(claude, request);
    return request;
  }

  private isFresh(entry: CachedLogin): boolean {
    const ttl =
      entry.login.state === "logged-in"
        ? LOGGED_IN_TTL_MS
        : NOT_LOGGED_IN_TTL_MS;
    return this.deps.now() - entry.checkedAt <= ttl;
  }
}

export function createClaudeHostEntry(deps: ClaudeHostDependencies) {
  const logins = new LoginCache(deps);
  let lastLatencyMs: number | null = null;
  return experimental_defineHostEntry({
    contract: claudeHostContract,
    handlers: {
      complete: async (input, context): Promise<CompleteOutput> => {
        try {
          const result = await complete(
            deps,
            context.experimental_paths,
            input,
            context.signal,
          );
          lastLatencyMs = result.durationMs;
          return result;
        } catch (error) {
          return toFailure(error);
        }
      },
      status: async (input, context): Promise<ClaudeStatus> => {
        const claude = await resolveClaude(deps, input.claudePath);
        if (claude === null) {
          return { claudePath: null, login: null, lastLatencyMs };
        }
        const { tempDir } = context.experimental_paths;
        await mkdir(tempDir, { recursive: true });
        const login = await logins.get(claude, tempDir, input.refresh);
        return { claudePath: claude, login, lastLatencyMs };
      },
    },
  });
}

const home = homedir();

export default createClaudeHostEntry({
  env: process.env,
  fallbackBinDirs: [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ],
  now: () => Date.now(),
});
