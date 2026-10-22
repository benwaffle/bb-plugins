import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { bundledDataset, entityKind, KINDS, type Dataset } from "./dataset";
import { formatEntity, formatHit } from "./format";
import { resolve, search } from "./search";
import type { EntityKind } from "./types";

export const TOOL_NAME = "telecom_ref_lookup";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

const kindSchema = z.enum(KINDS as [EntityKind, ...EntityKind[]]);

export const lookupParameters = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'An abbreviation, name, code, or entity id: "ULR", "Subscription-Data", "AVP 1400", "S6a", "HSS", "diam.avp/10415/1400".',
    ),
  kind: kindSchema
    .optional()
    .describe("Only this kind: cmd (Diameter command), avp, app (Diameter application), if (interface), nf (network function)."),
  interface: z.string().max(40).optional().describe('Only entities on this interface, by name or id: "S6a", "if/Gx".'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Matches to return, ${DEFAULT_LIMIT} by default.`),
});

export type LookupInput = z.output<typeof lookupParameters>;

/** "S6a" or "if/S6a" to the interface id, matching names case-insensitively. */
function interfaceId(dataset: Dataset, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (entityKind(value) === "if" && dataset.byId.has(value)) return value;
  const wanted = value.toLowerCase();
  for (const entity of dataset.byId.values()) {
    if (entity.kind === "if" && (entity.name.toLowerCase() === wanted || entity.id.slice(3).toLowerCase() === wanted)) {
      return entity.id;
    }
  }
  throw new Error(`no interface named "${value}"`);
}

/**
 * Markdown for a lookup: the full entry when the query names one entity
 * exactly, followed by the other top matches with their descriptions and
 * spec references.
 */
export function lookup(dataset: Dataset, input: LookupInput, pluginId: string): string {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const filters = { kinds: input.kind ? [input.kind] : [], interface: interfaceId(dataset, input.interface) };
  const exact = filters.kinds.length === 0 && filters.interface === null ? resolve(dataset, input.query) : null;
  const hits = search(dataset, input.query, filters, limit + 1).filter((hit) => hit.id !== exact?.id);
  const parts: string[] = [];
  if (exact) parts.push(formatEntity(exact, dataset, pluginId));
  const others = hits.slice(0, exact ? limit - 1 : limit);
  if (others.length > 0) {
    if (exact) parts.push("Other matches:");
    parts.push(...others.map((hit) => formatHit(hit, dataset)));
  }
  if (parts.length === 0) {
    return `No telecom-ref entry matches "${input.query}". Try an abbreviation (ULR), a name (Subscription-Data), or a code (1400).`;
  }
  parts.push(`Rel-${dataset.meta.release} data. ${dataset.meta.notice}`);
  return parts.join("\n\n");
}

export default function plugin(bb: BbPluginApi): void {
  const dataset = bundledDataset();

  bb.agents.registerTool({
    name: TOOL_NAME,
    description:
      "Look up 3GPP Rel-18 Diameter applications, commands, and AVPs (codes, vendor, type, flag rules, ABNF), EPC and 5GC interfaces, and network functions. Returns the best matches with summaries, cross-links, and spec clause references.",
    instructions: `Use ${TOOL_NAME} for Diameter AVP and command codes, flag rules, message formats, and which interface or network function uses them, instead of recalling them from memory. Cite the spec clause it returns.`,
    presentation: { label: { pending: "Looking up telecom reference", completed: "Looked up telecom reference" } },
    parameters: lookupParameters,
    execute(input) {
      try {
        return lookup(dataset, input, bb.pluginId);
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });

  const jsonOption = { json: { type: "boolean", description: "Print the result as JSON" } } as const;

  bb.cli.register(
    defineCli({
      name: "telecom-ref",
      summary: "Search 3GPP Rel-18 Diameter commands, AVPs, and applications, interfaces, and network functions",
      commands: {
        search: cliCommand({
          summary: "List the best matches for an abbreviation, name, or code",
          positionals: [{ name: "query", description: 'For example "ULR", "Subscription-Data", "1400", "S6a"', required: true, variadic: true }],
          options: {
            ...jsonOption,
            kind: { type: "enum", values: [...KINDS], description: "Only this kind: cmd, avp, app, if, nf" },
            interface: { type: "string", description: 'Only entities on this interface, for example "S6a"' },
            limit: { type: "integer", min: 1, max: MAX_LIMIT, description: `Matches to print, 1-${MAX_LIMIT} (default 10)` },
          },
          async run(input) {
            const query = [input.positionals.query].flat().join(" ");
            const limit = input.options.limit ?? 10;
            let filterInterface: string | null;
            try {
              filterInterface = interfaceId(dataset, input.options.interface);
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), {
                code: "unknown_interface",
                hint: "Run `bb telecom-ref search <name> --kind if` to find interface names.",
              });
            }
            const hits = search(dataset, query, { kinds: input.options.kind ? [input.options.kind] : [], interface: filterInterface }, limit);
            if (input.options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(hits.map(({ id, score, match, entity }) => ({ id, score, match, entity })))}\n` };
            }
            if (hits.length === 0) return { exitCode: 1, stderr: `no match for "${query}"\n` };
            return { exitCode: 0, stdout: `${hits.map((hit) => formatHit(hit, dataset)).join("\n\n")}\n` };
          },
        }),
        show: cliCommand({
          summary: "Print one entry with its cross-links, by id or exact abbreviation",
          positionals: [{ name: "id", description: 'An id such as "diam.avp/10415/1400", or an exact key such as "ULR"', required: true }],
          options: jsonOption,
          async run(input) {
            const entity = resolve(dataset, input.positionals.id);
            if (!entity) {
              throw new PluginCliError(`no single entry for "${input.positionals.id}"`, {
                code: "not_found",
                hint: `Run \`bb telecom-ref search ${input.positionals.id}\` to list candidates and their ids.`,
              });
            }
            return {
              exitCode: 0,
              stdout: input.options.json ? `${JSON.stringify(entity)}\n` : `${formatEntity(entity, dataset, bb.pluginId)}\n`,
            };
          },
        }),
      },
    }),
  );
}
