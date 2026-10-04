import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const repoSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo");
const threadIdSchema = z.string().min(1);

export const refSchema = z.object({
  kind: z.enum(["gh-pr", "gh-issue", "jira"]),
  key: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  source: z.enum([
    "review-target",
    "title",
    "body",
    "fixes",
    "refs",
    "mention",
    "sibling",
    "environment",
  ]),
});
export type ThreadRef = z.infer<typeof refSchema>;

const reviewStateSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);

export const queueEntrySchema = z.object({
  repo: repoSchema,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  author: z.string(),
  authorAvatarUrl: z.string().nullable(),
  headRefName: z.string(),
  ticketKey: z.string().nullable(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  me: z.enum([
    "author",
    "requested",
    "approved",
    "approved-stale",
    "changes-requested",
    "commented",
    "none",
  ]),
  bucket: z.enum([
    "approval-stale",
    "requested",
    "requested-approved",
    "commented",
    "other",
    "approved",
  ]),
  otherReviews: z.array(
    z.object({ login: z.string(), avatarUrl: z.string().nullable(), state: reviewStateSchema }),
  ),
  agent: z.object({
    state: z.enum(["none", "opened", "reviewing", "brief-ready", "follow-ups"]),
    threadId: z.string().nullable(),
  }),
});
export type QueueEntry = z.infer<typeof queueEntrySchema>;

export const ticketSchema = z.object({
  key: z.string(),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  url: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

const queueResultSchema = z.object({
  viewer: z.string(),
  fetchedAt: z.string(),
  githubPanel: z.boolean(),
  entries: z.array(queueEntrySchema),
  tickets: z.array(ticketSchema),
  errors: z.array(z.object({ repo: z.string(), message: z.string() })),
});
export type QueueResult = z.infer<typeof queueResultSchema>;

const refsResultSchema = z.object({
  refs: z.array(refSchema),
  tickets: z.array(ticketSchema),
  worktree: z.object({ path: z.string(), isLocal: z.boolean() }).nullable(),
  githubPanel: z.boolean(),
});
export type RefsResult = z.infer<typeof refsResultSchema>;

const relatedResultSchema = z.object({
  tickets: z.array(z.string()),
  threads: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      firstMessage: z.string().nullable(),
      tickets: z.array(z.string()),
      pulls: z.array(z.string()),
    }),
  ),
});
export type RelatedResult = z.infer<typeof relatedResultSchema>;

const sidebarGroupsResultSchema = z.object({
  githubPanel: z.boolean(),
  tickets: z.array(ticketSchema),
  threadTickets: z.array(z.object({ threadId: threadIdSchema, ticketKey: z.string() })),
  pulls: z.array(z.object({ projectId: z.string(), entry: queueEntrySchema })),
});
export type SidebarGroupsResult = z.infer<typeof sidebarGroupsResultSchema>;

export const rpcContract = defineRpcContract({
  reviewQueue: {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: queueResultSchema,
  },
  sidebarGroups: {
    input: z.object({}).strict(),
    output: sidebarGroupsResultSchema,
  },
  startReview: {
    input: z.object({ repo: repoSchema, number: z.number().int().positive() }).strict(),
    output: z.object({ threadId: threadIdSchema, created: z.boolean() }),
  },
  threadRefs: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: refsResultSchema,
  },
  relatedThreads: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: relatedResultSchema,
  },
  runReview: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ delivery: z.enum(["sent", "queued"]) }),
  },
  openWorktree: {
    input: z
      .object({ threadId: threadIdSchema, editor: z.enum(["goland", "vscode"]) })
      .strict(),
    output: z.object({
      opened: z.boolean(),
      path: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
});
