import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract.js";
import { actionKind, flattenKeymap, formatKeyPath, lookup, parseKeyPath, parseKeymap, type Keymap } from "./keymap.js";

export { rpcContract };

export const KEYMAP_FILE = "keymap.json";

async function readKeymapText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function describeLine(keys: readonly string[], keymap: Keymap): string {
  const node = lookup(keymap.root, keys);
  const path = `SPC ${formatKeyPath(keys)}`;
  if (node === undefined) return `${path} is undefined`;
  if (node.kind === "prefix") return `${path} is the +${node.label} prefix`;
  return `${path} runs ${node.action} (${node.label})${node.custom ? ", from keymap.json" : ""}`;
}

export default function plugin(bb: BbPluginApi): void {
  const keymapPath = () => join(bb.server.experimental_dataDir, "plugins", bb.pluginId, KEYMAP_FILE);
  const load = async () => parseKeymap(await readKeymapText(keymapPath()));

  bb.rpc.register(rpcContract, {
    async keymap() {
      const path = keymapPath();
      return { path, text: await readKeymapText(path) };
    },
  });

  const jsonOption = { json: { type: "boolean", description: "Print the result as JSON" } } as const;

  bb.cli.register(
    defineCli({
      name: "leader-keys",
      summary: "Inspect the leader-key map: list bindings, describe a key sequence, find keymap.json",
      commands: {
        list: cliCommand({
          summary: "List every leader binding with its command, and any keymap.json errors",
          options: jsonOption,
          async run(input) {
            const keymap = await load();
            const rows = flattenKeymap(keymap.root);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify({
                  bindings: rows.map((row) => ({ ...row, keys: formatKeyPath(row.keys), kind: actionKind(row.action) })),
                  errors: keymap.errors,
                })}\n`,
              };
            }
            const lines = rows.map(
              (row) => `SPC ${formatKeyPath(row.keys)}\t${row.action}\t${row.label}${row.custom ? "\tcustom" : ""}`,
            );
            const errors = keymap.errors.map((error) => `error: ${error}`);
            return { exitCode: 0, stdout: `${[...lines, ...errors].join("\n")}\n` };
          },
        }),
        describe: cliCommand({
          summary: "Show what a key sequence after the leader does, e.g. `bb leader-keys describe f R`",
          positionals: [
            { name: "keys", description: "Keys after the leader, separated by spaces", required: true, variadic: true },
          ],
          async run(input) {
            const raw = input.positionals.keys;
            const keys = parseKeyPath(Array.isArray(raw) ? raw.join(" ") : String(raw));
            if (keys === null) {
              throw new PluginCliError("not a key sequence", {
                code: "invalid_keys",
                hint: "Pass single keys separated by spaces, for example `bb leader-keys describe f R` or `describe SPC`.",
              });
            }
            return { exitCode: 0, stdout: `${describeLine(keys, await load())}\n` };
          },
        }),
        path: cliCommand({
          summary: "Print the path of keymap.json, the file that overrides the built-in leader map",
          async run() {
            return { exitCode: 0, stdout: `${keymapPath()}\n` };
          },
        }),
      },
    }),
  );
}
