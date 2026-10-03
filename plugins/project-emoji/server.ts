import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { REALTIME_CHANNEL } from "./channel.js";
import { rpcContract, type EmojiAssignment } from "./contract.js";
import { parseEmoji, type ProjectFacts } from "./emoji.js";
import { createEmojiStore } from "./store.js";

export { rpcContract };

async function listProjectFacts(bb: BbPluginApi): Promise<ProjectFacts[]> {
  const projects = await bb.sdk.projects.list();
  return [...projects]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((project) => ({
      id: project.id,
      name: project.name,
      kind: project.kind,
      paths: project.sources.map((source) => source.path),
      gitRemoteUrl: project.gitRemoteUrl,
    }));
}

function requireEmoji(input: string): string {
  const emoji = parseEmoji(input);
  if (emoji === null) {
    throw new PluginCliError(`"${input}" is not a single emoji`, {
      code: "invalid_emoji",
      hint: "Pass exactly one emoji, for example `bb project-emoji set <projectId> 🚀`.",
    });
  }
  return emoji;
}

function requireProject(projects: readonly ProjectFacts[], projectId: string): void {
  if (!projects.some((project) => project.id === projectId)) {
    throw new PluginCliError(`no project with id ${projectId}`, {
      code: "project_not_found",
      hint: "Run `bb project-emoji list` to see project ids.",
    });
  }
}

function formatAssignment(assignment: EmojiAssignment, name: string): string {
  return `${assignment.emoji}\t${assignment.source}\t${assignment.projectId}\t${name}`;
}

export default function plugin(bb: BbPluginApi): void {
  const store = createEmojiStore(bb.storage.kv);

  function announce(): void {
    bb.realtime.publish(REALTIME_CHANNEL, null);
  }

  async function setManual(projectId: string, rawEmoji: string): Promise<EmojiAssignment> {
    const emoji = requireEmoji(rawEmoji);
    requireProject(await listProjectFacts(bb), projectId);
    const assignment = await store.setManual(projectId, emoji);
    announce();
    return assignment;
  }

  async function reset(projectId: string): Promise<EmojiAssignment> {
    const projects = await listProjectFacts(bb);
    requireProject(projects, projectId);
    const assignment = await store.reset(projects, projectId);
    announce();
    return assignment;
  }

  bb.rpc.register(rpcContract, {
    async list() {
      return { assignments: await store.resolve(await listProjectFacts(bb)) };
    },
    set({ projectId, emoji }) {
      return setManual(projectId, emoji);
    },
    reset({ projectId }) {
      return reset(projectId);
    },
  });

  const projectIdPositional = {
    name: "projectId",
    description: "Project id, as shown by `bb project-emoji list` or `bb project list`",
    required: true,
  } as const;
  const jsonOption = {
    json: { type: "boolean", description: "Print the result as JSON" },
  } as const;

  bb.cli.register(
    defineCli({
      name: "project-emoji",
      summary: "Show or change the emoji beside each project in the sidebar",
      commands: {
        list: cliCommand({
          summary: "List every project's emoji and whether it was set by hand or picked automatically",
          options: jsonOption,
          async run(input) {
            const projects = await listProjectFacts(bb);
            const assignments = await store.resolve(projects);
            if (input.options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify({ assignments })}\n` };
            }
            const names = new Map(projects.map((project) => [project.id, project.name]));
            const lines = assignments.map((assignment) =>
              formatAssignment(assignment, names.get(assignment.projectId) ?? ""),
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n` };
          },
        }),
        set: cliCommand({
          summary: "Pin a project's emoji",
          positionals: [
            projectIdPositional,
            { name: "emoji", description: "Exactly one emoji", required: true },
          ],
          options: jsonOption,
          async run(input) {
            const assignment = await setManual(input.positionals.projectId, input.positionals.emoji);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? `${JSON.stringify(assignment)}\n`
                : `${assignment.emoji} pinned for ${assignment.projectId}\n`,
            };
          },
        }),
        clear: cliCommand({
          summary: "Drop a pinned emoji and go back to the automatic pick",
          aliases: ["reset"],
          positionals: [projectIdPositional],
          options: jsonOption,
          async run(input) {
            const assignment = await reset(input.positionals.projectId);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? `${JSON.stringify(assignment)}\n`
                : `${assignment.emoji} picked automatically for ${assignment.projectId}\n`,
            };
          },
        }),
      },
    }),
  );
}
