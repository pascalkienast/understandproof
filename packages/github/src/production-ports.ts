import { z } from "zod";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const decimalIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .refine((value) => Number.isSafeInteger(Number(value)), {
    message: "must be a positive, safely representable GitHub numeric ID",
  });
const repositoryPartSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== "." && value !== "..", {
    message: "must be a repository path segment",
  });

export const GithubRepositoryBindingSchema = z
  .object({
    installationId: decimalIdSchema,
    repositoryId: decimalIdSchema,
    owner: repositoryPartSchema,
    repositoryName: repositoryPartSchema,
  })
  .strict();

export type GithubRepositoryBinding = z.infer<
  typeof GithubRepositoryBindingSchema
>;

export const GithubPullRequestReadInputSchema =
  GithubRepositoryBindingSchema.extend({
    pullNumber: z.number().int().positive().max(2_147_483_647),
    expectedHeadSha: shaSchema,
    expectedBaseSha: shaSchema,
  }).strict();

export type GithubPullRequestReadInput = z.infer<
  typeof GithubPullRequestReadInputSchema
>;

/** Git object kind at the exact immutable head/base paths used by the PR. */
export const GithubChangedFileGitKindSchema = z.enum([
  "blob",
  "symlink",
  "submodule",
]);

export type GithubChangedFileGitKind = z.infer<
  typeof GithubChangedFileGitKindSchema
>;

export const GithubChangedFileSchema = z
  .object({
    sha: shaSchema.nullable(),
    filename: z.string().min(1).max(1_024),
    previousFilename: z.string().min(1).max(1_024).nullable(),
    status: z.enum([
      "added",
      "removed",
      "modified",
      "renamed",
      "copied",
      "changed",
      "unchanged",
    ]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    patch: z.string().nullable(),
    gitKind: GithubChangedFileGitKindSchema,
  })
  .strict();

export type GithubChangedFile = z.infer<typeof GithubChangedFileSchema>;

export const GithubPullRequestLimitsSchema = z
  .object({
    files: z.boolean(),
    patchBytes: z.boolean(),
    patchUnavailable: z.boolean(),
  })
  .strict();

export const GithubPullRequestSnapshotSchema = z
  .object({
    githubPullRequestId: decimalIdSchema,
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    draft: z.boolean(),
    title: z.string().max(4_096),
    body: z.string().max(65_536).nullable(),
    authorId: decimalIdSchema,
    authorLogin: z.string().min(1).max(100),
    headSha: shaSchema,
    baseSha: shaSchema,
    changedFiles: z.number().int().nonnegative(),
    isFork: z.boolean(),
    files: z.array(GithubChangedFileSchema),
    limitsHit: GithubPullRequestLimitsSchema,
  })
  .strict();

export type GithubPullRequestSnapshot = z.infer<
  typeof GithubPullRequestSnapshotSchema
>;

export interface GithubPullRequestPort {
  load(input: GithubPullRequestReadInput): Promise<GithubPullRequestSnapshot>;
  /** Forces a newly minted installation token before this authoritative read. */
  loadFresh?(
    input: GithubPullRequestReadInput,
  ): Promise<GithubPullRequestSnapshot>;
}

export const GithubCurrentHeadInputSchema =
  GithubRepositoryBindingSchema.extend({
    pullNumber: z.number().int().positive().max(2_147_483_647),
  }).strict();

export type GithubCurrentHeadInput = z.infer<
  typeof GithubCurrentHeadInputSchema
>;

export const GithubCurrentHeadSchema = z
  .object({
    headSha: shaSchema,
    baseSha: shaSchema,
    state: z.enum(["open", "closed"]),
  })
  .strict();

export type GithubCurrentHead = z.infer<typeof GithubCurrentHeadSchema>;

export interface GithubPullRequestHeadPort {
  getCurrentHead(input: GithubCurrentHeadInput): Promise<GithubCurrentHead>;
  /** Forces a newly minted installation token before this authoritative read. */
  getCurrentHeadFresh?(
    input: GithubCurrentHeadInput,
  ): Promise<GithubCurrentHead>;
}

const checkStatusSchema = z.enum(["queued", "in_progress", "completed"]);
const checkConclusionSchema = z
  .enum(["action_required", "success", "neutral", "cancelled"])
  .nullable();

const checkIntentShape = {
  installationId: decimalIdSchema,
  repositoryId: decimalIdSchema,
  owner: repositoryPartSchema,
  repositoryName: repositoryPartSchema,
  revisionId: z.string().uuid(),
  pullNumber: z.number().int().positive().max(2_147_483_647),
  headSha: shaSchema,
  baseSha: shaSchema,
  expectedPullRequestState: z.enum(["open", "closed"]),
  status: checkStatusSchema,
  conclusion: checkConclusionSchema,
  summary: z.string().min(1).max(500),
  detailsUrl: z.url({ protocol: /^https$/u }).max(2_048),
} as const;

function refineCheckIntent(
  input: { status: z.infer<typeof checkStatusSchema>; conclusion: unknown },
  context: z.RefinementCtx,
): void {
  if (input.status === "completed" && input.conclusion === null) {
    context.addIssue({
      code: "custom",
      path: ["conclusion"],
      message: "is required for a completed check",
    });
  }
  if (input.status !== "completed" && input.conclusion !== null) {
    context.addIssue({
      code: "custom",
      path: ["conclusion"],
      message: "must be null before completion",
    });
  }
}

export const CheckIntentInputSchema = z
  .object(checkIntentShape)
  .strict()
  .superRefine(refineCheckIntent);

export type CheckIntentInput = z.infer<typeof CheckIntentInputSchema>;

export const CheckRunReferenceSchema = z
  .object({ checkRunId: decimalIdSchema })
  .strict();

export type CheckRunReference = z.infer<typeof CheckRunReferenceSchema>;

export const CheckUpdateInputSchema = z
  .object({ ...checkIntentShape, checkRunId: decimalIdSchema })
  .strict()
  .superRefine(refineCheckIntent);

export type CheckUpdateInput = CheckIntentInput & CheckRunReference;

export const StaleCheckUpdateInputSchema = z
  .object({
    ...checkIntentShape,
    checkRunId: decimalIdSchema,
  })
  .strict()
  .superRefine(refineCheckIntent);
export type StaleCheckUpdateInput = z.infer<typeof StaleCheckUpdateInputSchema>;

/** Storage-neutral network port. Persistence belongs to the caller. */
export interface GithubCheckRunPort {
  create(input: CheckIntentInput): Promise<CheckRunReference>;
  update(input: CheckUpdateInput): Promise<CheckRunReference>;
  invalidateStale(input: StaleCheckUpdateInput): Promise<CheckRunReference>;
  findExisting(input: CheckIntentInput): Promise<CheckRunReference | null>;
}

export const PullRequestCommentInputSchema =
  GithubRepositoryBindingSchema.extend({
    pullNumber: z.number().int().positive().max(2_147_483_647),
    revisionId: z.string().uuid(),
    headSha: shaSchema,
    baseSha: shaSchema,
    expectedPullRequestState: z.literal("open"),
    detailsUrl: z.url({ protocol: /^https$/u }).max(2_048),
  }).strict();

export type PullRequestCommentInput = z.infer<
  typeof PullRequestCommentInputSchema
>;

/** Keeps one App-owned contributor entry comment current for an open PR. */
export interface GithubPullRequestCommentPort {
  upsert(input: PullRequestCommentInput): Promise<void>;
}

const userTokenSchema = z.string().min(16).max(1_024);

export const GithubAuthenticatedUserInputSchema = z
  .object({ userToken: userTokenSchema })
  .strict();

export const GithubAuthenticatedUserSchema = z
  .object({
    id: decimalIdSchema,
    login: z.string().min(1).max(100),
  })
  .strict();

export type GithubAuthenticatedUser = z.infer<
  typeof GithubAuthenticatedUserSchema
>;

export const GithubCollaboratorPermissionInputSchema = z
  .object({
    userToken: userTokenSchema,
    owner: repositoryPartSchema,
    repositoryName: repositoryPartSchema,
    username: z.string().min(1).max(100),
  })
  .strict();

export const GithubCollaboratorPermissionSchema = z
  .object({
    permission: z.enum(["admin", "write", "read", "none"]),
    roleName: z.string().min(1).max(100),
  })
  .strict();

export type GithubAuthenticatedUserInput = z.infer<
  typeof GithubAuthenticatedUserInputSchema
>;
export type GithubCollaboratorPermissionInput = z.infer<
  typeof GithubCollaboratorPermissionInputSchema
>;
export type GithubCollaboratorPermission = z.infer<
  typeof GithubCollaboratorPermissionSchema
>;

export const GithubAccessibleAppInstallationsInputSchema =
  GithubAuthenticatedUserInputSchema;

export const GithubAccessibleAppInstallationIdSchema = decimalIdSchema;

export type GithubAccessibleAppInstallationsInput = z.infer<
  typeof GithubAccessibleAppInstallationsInputSchema
>;

export const GithubWritableAppRepositoriesInputSchema = z
  .object({
    userToken: userTokenSchema,
    githubInstallationIds: z
      .array(GithubAccessibleAppInstallationIdSchema)
      .min(1)
      .max(32),
  })
  .strict();

export const GithubWritableAppRepositoryIdSchema = decimalIdSchema;

export type GithubWritableAppRepositoriesInput = z.infer<
  typeof GithubWritableAppRepositoriesInputSchema
>;

/** Request-scoped user-token port. Implementations must never cache tokens. */
export interface GithubUserAuthorizationPort {
  getAuthenticatedUser(
    input: GithubAuthenticatedUserInput,
  ): Promise<GithubAuthenticatedUser>;
  getCollaboratorPermission(
    input: GithubCollaboratorPermissionInput,
  ): Promise<GithubCollaboratorPermission>;
  listAccessibleAppInstallations(
    input: GithubAccessibleAppInstallationsInput,
  ): Promise<readonly string[]>;
  listWritableAppRepositories(
    input: GithubWritableAppRepositoriesInput,
  ): Promise<readonly string[]>;
}

// Repository rulesets must require this exact name from the existing GitHub App.
// See docs/operations/understandproof-rename.md before changing it.
export const GITHUB_CHECK_NAME =
  "UnderstandProof / understanding required" as const;
