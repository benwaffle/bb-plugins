import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandError, runCommand } from "./tools.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe("runCommand", () => {
  it("returns stdout, and rejects with stderr when the command fails", async () => {
    await expect(runCommand("sh", ["-c", "echo out"], { timeoutMs: 5_000 })).resolves.toBe("out\n");
    await expect(runCommand("sh", ["-c", "echo broke >&2; exit 3"], { timeoutMs: 5_000 })).rejects.toThrow(
      "sh -c echo broke >&2; exit 3: broke",
    );
  });

  it("keeps what a failed command printed to stdout", async () => {
    const failed = await runCommand("sh", ["-c", "echo partial; exit 1"], { timeoutMs: 5_000 }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CommandError);
    expect((failed as CommandError).stdout).toBe("partial\n");
  });

  it("rejects at the timeout and kills the command with the children holding its output", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "pr-review-run-")), "pid");
    const started = Date.now();
    await expect(
      runCommand("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 300 }),
    ).rejects.toThrow("timed out after 300ms");
    expect(Date.now() - started).toBeLessThan(2_000);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(await eventually(() => !alive(grandchild))).toBe(true);
  });
});
