import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { MIGRATIONS, openLedger } from "../ledger.js";

export const SESSION_A = "11111111-1111-4111-8111-111111111111";
export const SESSION_B = "22222222-2222-4222-8222-222222222222";

export function memoryLedger() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return openLedger(db);
}

/** A writable copy of the fixture `~/.claude/projects` tree. */
export function fixtureProjects(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-stats-"));
  cpSync(fileURLToPath(new URL("./fixtures/projects", import.meta.url)), root, { recursive: true });
  return root;
}
