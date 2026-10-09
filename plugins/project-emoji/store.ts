import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ColorPin, EmojiAssignment } from "./contract.js";
import { autoEmoji, type ProjectFacts } from "./emoji.js";

type Kv = BbPluginApi["storage"]["kv"];

interface StoredAssignment {
  emoji: string;
  source: "manual" | "auto";
}

const KEY_PREFIX = "project:";

function keyFor(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

function parseStored(value: unknown): StoredAssignment | null {
  if (typeof value !== "object" || value === null) return null;
  const { emoji, source } = value as Record<string, unknown>;
  if (typeof emoji !== "string") return null;
  if (source !== "manual" && source !== "auto") return null;
  return { emoji, source };
}

export class UnknownProjectError extends Error {
  constructor(readonly projectId: string) {
    super(`no project with id ${projectId}`);
  }
}

export interface EmojiStore {
  resolve(projects: readonly ProjectFacts[]): Promise<EmojiAssignment[]>;
  setManual(projectId: string, emoji: string): Promise<EmojiAssignment>;
  reset(projects: readonly ProjectFacts[], projectId: string): Promise<EmojiAssignment>;
}

export function createEmojiStore(kv: Kv): EmojiStore {
  async function readAll(): Promise<Map<string, StoredAssignment>> {
    const keys = await kv.list(KEY_PREFIX);
    const entries = await Promise.all(
      keys.map(async (key) => {
        const stored = parseStored(await kv.get<unknown>(key));
        return stored === null
          ? null
          : ([key.slice(KEY_PREFIX.length), stored] as const);
      }),
    );
    return new Map(entries.filter((entry) => entry !== null));
  }

  async function assignMissing(
    projects: readonly ProjectFacts[],
    stored: Map<string, StoredAssignment>,
  ): Promise<void> {
    const taken = new Set([...stored.values()].map((entry) => entry.emoji));
    for (const project of projects) {
      if (stored.has(project.id)) continue;
      const assignment: StoredAssignment = {
        emoji: autoEmoji(project, taken),
        source: "auto",
      };
      await kv.set(keyFor(project.id), assignment);
      stored.set(project.id, assignment);
      taken.add(assignment.emoji);
    }
  }

  return {
    async resolve(projects) {
      const stored = await readAll();
      await assignMissing(projects, stored);
      return projects.map((project) => ({
        projectId: project.id,
        ...stored.get(project.id)!,
      }));
    },

    async setManual(projectId, emoji) {
      const assignment: StoredAssignment = { emoji, source: "manual" };
      await kv.set(keyFor(projectId), assignment);
      return { projectId, ...assignment };
    },

    async reset(projects, projectId) {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) throw new UnknownProjectError(projectId);
      await kv.delete(keyFor(projectId));
      const stored = await readAll();
      await assignMissing([project], stored);
      return { projectId, ...stored.get(projectId)! };
    },
  };
}

const COLOR_PREFIX = "color:";

export interface ColorStore {
  list(): Promise<ColorPin[]>;
  set(projectId: string, color: string): Promise<void>;
  clear(projectId: string): Promise<void>;
}

export function createColorStore(kv: Kv): ColorStore {
  return {
    async list() {
      const keys = await kv.list(COLOR_PREFIX);
      const pins = await Promise.all(
        keys.map(async (key) => {
          const color = await kv.get<unknown>(key);
          return typeof color === "string"
            ? { projectId: key.slice(COLOR_PREFIX.length), color }
            : null;
        }),
      );
      return pins.filter((pin) => pin !== null);
    },

    async set(projectId, color) {
      await kv.set(`${COLOR_PREFIX}${projectId}`, color);
    },

    async clear(projectId) {
      await kv.delete(`${COLOR_PREFIX}${projectId}`);
    },
  };
}
