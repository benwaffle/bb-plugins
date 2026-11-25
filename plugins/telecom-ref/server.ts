import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { bundledDataset, entityKind, GTP_VERSIONS, KINDS, type Dataset } from "./dataset";
import { DIAGRAMS, diagramById, diagramPath, diagramsShowing, diagramText } from "./diagrams";
import { formatEntity, formatHit } from "./format";
import { normalize, resolve, search, type SearchFilters } from "./search";
import type { Entity, EntityKind } from "./types";

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
      'An abbreviation, name, code, or entity id: "ULR", "Subscription-Data", "AVP 1400", "S6a", "HSS", "Nsmf_PDUSession", "PFCP", "Create Session Request", "F-TEID", "gtpv2 32", "gtpv2 ie 87", "gtp-u ext 0x85", "diam.avp/10415/1400", "gtp.msg/v2c/32".',
    ),
  kind: kindSchema
    .optional()
    .describe(
      "Only this kind: cmd (Diameter command), avp, app (Diameter application), if (interface), nf (network function), svc (5GC SBI service), proto (protocol), gtpmsg (GTP message), gtpie (GTP information element), gtpcause (GTP cause value), gtpext (GTP-U or GTPv1-C extension header).",
    ),
  interface: z.string().max(40).optional().describe('Only entities on this interface, by name or id: "S6a", "if/Gx", "S11".'),
  protocol: z
    .string()
    .max(40)
    .optional()
    .describe('Only this protocol and its entries, by name, alias, or id: "GTPv2-C", "GTPv1-C", "GTP-U" (GTPv1-U), "PFCP", "proto/GTPv2-C".'),
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

/** "GTPv2-C", "gtpv1-u", "v2c", or "proto/GTP-U" to the protocol id, matching names and aliases loosely. */
function protocolId(dataset: Dataset, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (entityKind(value) === "proto" && dataset.byId.has(value)) return value;
  const wanted = normalize(value);
  for (const [slug, version] of Object.entries(GTP_VERSIONS)) {
    if (wanted === slug) return version.protocol;
  }
  for (const entity of dataset.byId.values()) {
    if (entity.kind === "proto" && [entity.name, ...entity.aliases].some((name) => normalize(name) === wanted)) return entity.id;
  }
  throw new Error(`no protocol named "${value}"`);
}

/** The one entry a filtered search finds by exact name or code, or null when it finds none or several. */
function resolveFiltered(dataset: Dataset, query: string, filters: SearchFilters): Entity | null {
  const [top, next] = search(dataset, query, filters, 2);
  if (!top || (top.match !== "exact" && top.match !== "code")) return null;
  if (next && next.score === top.score) return null;
  return top.entity;
}

/**
 * Markdown for a lookup: the full entry when the query names one entity
 * exactly (within the filters, when given), followed by the other top
 * matches with their descriptions and spec references.
 */
export function lookup(dataset: Dataset, input: LookupInput, pluginId: string): string {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const filters = {
    kinds: input.kind ? [input.kind] : [],
    interface: interfaceId(dataset, input.interface),
    protocol: protocolId(dataset, input.protocol),
  };
  const filtered = filters.kinds.length > 0 || filters.interface !== null || filters.protocol !== null;
  const exact = filtered ? resolveFiltered(dataset, input.query, filters) : resolve(dataset, input.query);
  const hits = search(dataset, input.query, filters, limit + 1).filter((hit) => hit.id !== exact?.id);
  const parts: string[] = [];
  if (exact) {
    const drawn = diagramsShowing(exact.id);
    const diagrams = drawn.map((diagram) => `${diagram.id} (${diagramPath(pluginId, diagram.id, exact.id)})`).join(", ");
    parts.push(drawn.length > 0 ? `${formatEntity(exact, dataset, pluginId)}\nDiagrams: ${diagrams}` : formatEntity(exact, dataset, pluginId));
  }
  const others = hits.slice(0, exact ? limit - 1 : limit);
  if (others.length > 0) {
    if (exact) parts.push("Other matches:");
    parts.push(...others.map((hit) => formatHit(hit, dataset)));
  }
  if (parts.length === 0) {
    return `No telecom-ref entry matches "${input.query}". Try an abbreviation (ULR), a name (Subscription-Data, Create Session Request), or a code (1400, "gtpv2 32").`;
  }
  parts.push(`Rel-${dataset.meta.release} data. ${dataset.meta.notice}`);
  return parts.join("\n\n");
}

export default function plugin(bb: BbPluginApi): void {
  const dataset = bundledDataset();

  bb.agents.registerTool({
    name: TOOL_NAME,
    description:
      "Look up 3GPP Rel-18 Diameter applications, commands, and AVPs (codes, vendor, type, flag rules, ABNF), GTPv2-C, GTPv1-C, and GTPv1-U messages (type values, request/response pairing, interfaces, per-message IE tables with presence and instance), IEs, cause values, and extension headers, EPC, CUPS, IMS, and 5GC interfaces, network functions, 5GC SBI services (producer, consumers, operations), and protocols (PFCP, GTP headers, NGAP, NAS, ...). Returns the best matches with summaries, cross-links, and spec clause references.",
    instructions: `Use ${TOOL_NAME} for Diameter AVP and command codes, flag rules, message formats, GTP message, IE, cause, and extension header values and message IE tables, reference points, SBI services and their operations, protocols, and which interface or network function uses them, instead of recalling them from memory. Cite the spec clause it returns.`,
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
      summary: "Search 3GPP Rel-18 Diameter commands, AVPs, and applications, GTP messages, IEs, causes, and extension headers, interfaces, network functions, SBI services, and protocols",
      commands: {
        search: cliCommand({
          summary: "List the best matches for an abbreviation, name, or code",
          positionals: [
            {
              name: "query",
              description: 'For example "ULR", "Subscription-Data", "1400", "S6a", "PFCP", "Nnrf_NFDiscovery", "Create Session Request", "F-TEID", "gtpv2 32"',
              required: true,
              variadic: true,
            },
          ],
          options: {
            ...jsonOption,
            kind: {
              type: "enum",
              values: [...KINDS],
              description: "Only this kind: cmd, avp, app, if, nf, svc, proto, gtpmsg, gtpie, gtpcause, gtpext",
            },
            interface: { type: "string", description: 'Only entities on this interface, for example "S6a"' },
            protocol: { type: "string", description: 'Only this protocol and its entries, for example "GTPv2-C", "GTPv1-C", "GTP-U"' },
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
            let filterProtocol: string | null;
            try {
              filterProtocol = protocolId(dataset, input.options.protocol);
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), {
                code: "unknown_protocol",
                hint: "Run `bb telecom-ref search <name> --kind proto` to find protocol names.",
              });
            }
            const filters = { kinds: input.options.kind ? [input.options.kind] : [], interface: filterInterface, protocol: filterProtocol };
            const hits = search(dataset, query, filters, limit);
            if (input.options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(hits.map(({ id, score, match, entity }) => ({ id, score, match, entity })))}\n` };
            }
            if (hits.length === 0) return { exitCode: 1, stderr: `no match for "${query}"\n` };
            return { exitCode: 0, stdout: `${hits.map((hit) => formatHit(hit, dataset)).join("\n\n")}\n` };
          },
        }),
        "diagram list": cliCommand({
          summary: "List the architecture diagrams (EPC, 5GC, interworking, IMS, roaming) with their spec figures",
          options: jsonOption,
          async run(input) {
            if (input.options.json) {
              const rows = DIAGRAMS.map(({ id, title, variant, group, figures }) => ({ id, title, variant, group, figures: figures.map(({ doc, clause, figure, title: name }) => ({ doc, clause, figure, title: name })) }));
              return { exitCode: 0, stdout: `${JSON.stringify(rows)}\n` };
            }
            const lines = DIAGRAMS.map((diagram) => {
              const figures = diagram.figures.map((figure) => `${figure.doc} Fig ${figure.figure}`).join("; ");
              return `${diagram.id}\t${diagram.title} · ${diagram.variant}\t${figures}`;
            });
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        "diagram show": cliCommand({
          summary: "Print one diagram as text: its spec figures, nodes, and each interface with its two ends",
          positionals: [{ name: "id", description: 'A diagram id from `diagram list`, for example "5gc-sba" or "interworking"', required: true }],
          options: jsonOption,
          async run(input) {
            const diagram = diagramById(input.positionals.id);
            if (!diagram) {
              throw new PluginCliError(`no diagram "${input.positionals.id}"`, {
                code: "not_found",
                hint: "Run `bb telecom-ref diagram list` for the diagram ids.",
              });
            }
            return { exitCode: 0, stdout: input.options.json ? `${JSON.stringify(diagram)}\n` : `${diagramText(diagram, dataset, bb.pluginId)}\n` };
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
