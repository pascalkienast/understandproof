import { createHash } from "node:crypto";
import {
  AnalysisSnapshotSchema,
  BoundedRevisionSourceV1Schema,
  PullRequestPatchSchema,
  analyzePullRequestPatch,
  boundedRevisionSourcePatch,
  buildBoundedRevisionSourceV1,
  buildGenerationContextV1,
  GithubRevisionSourceV1Schema,
  verifyGenerationContextV1AgainstAnalysis,
  type AnalysisSnapshot,
  type BoundedRevisionSourceV1,
  type GenerationContextV1,
  type GithubRevisionSourceV1,
  type PullRequestPatch,
} from "@understandproof/analysis";
import {
  PgBossGithubCheckOutbox,
  parseJobPayload,
  persistGithubRevisionSourceInTransaction,
  persistGithubCheckIntentInTransaction,
  scheduleJobInPgTransaction,
  type JobPayload,
} from "@understandproof/db";
import {
  DEFAULT_REPOSITORY_POLICY_V1,
  RepositoryPolicyV1Schema,
  type RepositoryPolicyV1,
} from "@understandproof/policy";
import {
  planProof,
  planProofBudget,
  type ProofQuestion,
} from "@understandproof/questions";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";

const ACTIVE_ATTEMPT_STATUSES = [
  "preparing",
  "ready",
  "active",
  "uploading",
  "processing",
  "review_required",
] as const;

const GITHUB_CHECK_NAME = "UnderstandProof / understanding required";

export type WorkerCheckIntentWriterInput = {
  revisionId: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "action_required" | "success" | "cancelled" | null;
  summary: string;
  reason:
    | "analysis_ready"
    | "preparation_failed"
    | "review_required"
    | "technical_retry"
    | "attempt_expired";
  idempotencyKey: string;
};

/** DB/outbox-only boundary. Implementations must never call GitHub remotely. */
export interface CheckIntentWriter {
  write(client: PoolClient, input: WorkerCheckIntentWriterInput): Promise<void>;
}

export function createWorkerCheckIntentWriter(
  queue: PgBoss,
  appBaseUrl: string,
): CheckIntentWriter {
  const baseUrl = new URL(appBaseUrl);
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.protocol !== "https:" &&
      !(
        baseUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)
      ))
  ) {
    throw new Error("Worker check details URL must use HTTPS or loopback HTTP");
  }
  const outbox = new PgBossGithubCheckOutbox(queue);
  return {
    async write(client, input): Promise<void> {
      await persistGithubCheckIntentInTransaction(client, outbox, {
        revisionId: input.revisionId,
        expectedHeadSha: input.headSha,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        name: GITHUB_CHECK_NAME,
        status: input.status,
        conclusion: input.conclusion,
        publicSummary: input.summary,
        detailsUrl: new URL(
          `/revisions/${input.revisionId}`,
          baseUrl,
        ).toString(),
      });
    },
  };
}

export type RevisionPatchRequest = {
  revisionId: string;
  owner: string;
  repositoryName: string;
  pullRequestNumber: number;
  githubPullRequestId: string;
  authorId: string;
  baseSha: string;
  headSha: string;
};

export interface RevisionPatchSource {
  loadPatch(input: RevisionPatchRequest): Promise<PullRequestPatch>;
}

export interface BoundedRevisionPatchSource extends RevisionPatchSource {
  loadBoundedSource(
    input: RevisionPatchRequest,
  ): Promise<BoundedRevisionSourceV1>;
}

interface MaterializingRevisionPatchSource extends BoundedRevisionPatchSource {
  loadImmutableSource(
    input: RevisionPatchRequest,
  ): Promise<GithubRevisionSourceV1>;
}

export interface GenerationContextWriter {
  persist(
    client: PoolClient,
    context: GenerationContextV1,
  ): Promise<{ id: string; replay: boolean }>;
}

/**
 * Explicit offline adapter for the fake-GitHub MVP. A productive adapter must
 * replace this with an installation-authorized, bounded patch fetch.
 */
export class LocalFakeRevisionPatchSource implements MaterializingRevisionPatchSource {
  async loadPatch(input: RevisionPatchRequest): Promise<PullRequestPatch> {
    return boundedRevisionSourcePatch(await this.loadBoundedSource(input));
  }

  async loadBoundedSource(
    input: RevisionPatchRequest,
  ): Promise<BoundedRevisionSourceV1> {
    const source = await this.loadImmutableSource(input);
    return buildBoundedRevisionSourceV1(source);
  }

  async loadImmutableSource(
    input: RevisionPatchRequest,
  ): Promise<GithubRevisionSourceV1> {
    const patch = [
      "@@ -1,1 +1,2 @@ bounded fake-GitHub patch",
      `-Previous behavior for ${input.owner}/${input.repositoryName}.`,
      `+Updated behavior for pull request #${String(input.pullRequestNumber)}.`,
      "+The contributor must explain the observable change and recovery path.",
    ].join("\n");
    return GithubRevisionSourceV1Schema.parse({
      githubPullRequestId: input.githubPullRequestId,
      number: input.pullRequestNumber,
      state: "open",
      draft: false,
      title: `Local fake pull request #${String(input.pullRequestNumber)}`,
      body: "Deterministic offline source for the local fake profile.",
      authorId: input.authorId,
      authorLogin: "local-fake",
      headSha: input.headSha,
      baseSha: input.baseSha,
      changedFiles: 1,
      isFork: false,
      files: [
        {
          sha: input.headSha,
          filename: `pull-requests/${String(input.pullRequestNumber)}.md`,
          previousFilename: null,
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch,
          gitKind: "blob",
        },
      ],
      limitsHit: {
        files: false,
        patchBytes: false,
        patchUnavailable: false,
      },
    });
  }
}

export type PrepareRevisionDependencies = {
  pool: Pool;
  queue: PgBoss;
  checkIntents: CheckIntentWriter;
  patchSource: RevisionPatchSource;
  generationContexts: GenerationContextWriter;
  /**
   * Gate-4 composition boundary. The production and local-fake workers always
   * provide this writer; omission keeps the frozen deterministic V1 path
   * available to older fixtures and explicit compatibility callers.
   */
  semanticGeneration?: {
    scheduleRevisionSemanticGeneration(
      client: PoolClient,
      input: {
        repositoryId: string;
        revisionId: string;
        generationContextId: string;
        repositoryPolicyId: string;
        headSha: string;
        questionBudget: number;
      },
    ): Promise<"created" | "replayed">;
  };
  clock?: { now(): Date };
};

export type PrepareRevisionResult =
  | { outcome: "stale" | "closed" | "split_recommended" }
  | {
      outcome: "preparation_failed";
      revisionId: string;
      headSha: string;
    }
  | {
      outcome: "semantic_generation_queued" | "semantic_generation_replayed";
      revisionId: string;
      headSha: string;
      generationContextId: string;
    }
  | {
      outcome: "ready" | "replayed";
      attemptId: string;
      revisionId: string;
      headSha: string;
    };

type RevisionContext = {
  revision_id: string;
  repository_id: string;
  owner: string;
  repository_name: string;
  active_policy_version: number;
  pull_request_number: number;
  github_pull_request_id: string;
  author_id: string;
  pull_request_state: string;
  base_sha: string;
  head_sha: string;
  is_current: boolean;
  received_at: Date;
};

export async function prepareRevision(
  rawPayload: JobPayload<"analysis.prepare-revision">,
  dependencies: PrepareRevisionDependencies,
): Promise<PrepareRevisionResult> {
  const payload = parseJobPayload("analysis.prepare-revision", rawPayload);
  const context = await loadRevisionContext(
    dependencies.pool,
    payload.revisionId,
  );
  if (
    !context ||
    !context.is_current ||
    context.head_sha !== payload.expectedHeadSha
  ) {
    return { outcome: "stale" };
  }
  if (context.pull_request_state !== "open") return { outcome: "closed" };

  const policy = await loadPolicy(dependencies.pool, context);
  const patchRequest = {
    revisionId: context.revision_id,
    owner: context.owner,
    repositoryName: context.repository_name,
    pullRequestNumber: context.pull_request_number,
    githubPullRequestId: context.github_pull_request_id,
    authorId: context.author_id,
    baseSha: context.base_sha,
    headSha: context.head_sha,
  };
  const boundedSource = await loadRequiredBoundedSource(
    dependencies.patchSource,
    patchRequest,
  );
  const immutableSource = await loadOptionalImmutableSource(
    dependencies.patchSource,
    patchRequest,
  );
  const patch = PullRequestPatchSchema.parse(
    boundedRevisionSourcePatch(boundedSource),
  );
  if (
    patch.baseSha !== context.base_sha ||
    patch.headSha !== context.head_sha
  ) {
    throw new Error("Patch source returned data for a different revision");
  }
  const analysis = analyzePullRequestPatch(patch);
  const proofBudget = planProofBudget({ analysis, policy });
  const diffHash = sha256(JSON.stringify(patch));
  const now = dependencies.clock?.now() ?? new Date();
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<RevisionContext>(
      `${REVISION_CONTEXT_SQL} AND revision.id = $1
       FOR UPDATE OF revision, repository`,
      [payload.revisionId],
    );
    const current = locked.rows[0];
    if (
      !current ||
      !current.is_current ||
      current.head_sha !== payload.expectedHeadSha ||
      current.pull_request_state !== "open" ||
      current.active_policy_version !== context.active_policy_version
    ) {
      await client.query("ROLLBACK");
      return { outcome: "stale" };
    }

    const frozenPolicyId = await ensureDefaultPolicy(
      client,
      current,
      policy,
      now,
    );
    if (immutableSource !== undefined) {
      const persistedSource = await persistGithubRevisionSourceInTransaction(
        client,
        {
          revisionId: current.revision_id,
          fetchedAt: current.received_at,
          source: immutableSource,
        },
      );
      if (persistedSource.sourceHash !== boundedSource.sourceHash) {
        throw new Error(
          "Immutable revision source conflicts with bounded data",
        );
      }
    }
    const analysisSnapshotId = await persistAnalysisSnapshotExactlyOnce(
      client,
      current.revision_id,
      analysis,
      diffHash,
    );
    const generationContext = buildGenerationContextV1({
      revisionId: current.revision_id,
      analysisSnapshotId,
      boundedSource,
      analysis,
    });
    verifyGenerationContextV1AgainstAnalysis(generationContext, analysis);
    const persistedGenerationContext =
      await dependencies.generationContexts.persist(client, generationContext);
    if (!persistedGenerationContext.id) {
      throw new Error("Generation context persistence returned no identity");
    }

    if (proofBudget.status === "split_recommended") {
      await dependencies.checkIntents.write(client, {
        revisionId: current.revision_id,
        headSha: current.head_sha,
        status: "completed",
        conclusion: "action_required",
        summary: `split or narrow the pull request for head ${current.head_sha}`,
        reason: "analysis_ready",
        idempotencyKey: payload.idempotencyKey,
      });
      await insertAuditOnce(client, {
        action: "analysis.split_recommended",
        objectId: current.revision_id,
        metadata: { headSha: current.head_sha, diffHash },
      });
      await client.query("COMMIT");
      return { outcome: "split_recommended" };
    }

    if (dependencies.semanticGeneration !== undefined) {
      const scheduled =
        await dependencies.semanticGeneration.scheduleRevisionSemanticGeneration(
          client,
          {
            repositoryId: current.repository_id,
            revisionId: current.revision_id,
            generationContextId: persistedGenerationContext.id,
            repositoryPolicyId: frozenPolicyId,
            headSha: current.head_sha,
            questionBudget: proofBudget.questionBudget,
          },
        );
      if (scheduled === "created") {
        await dependencies.checkIntents.write(client, {
          revisionId: current.revision_id,
          headSha: current.head_sha,
          status: "in_progress",
          conclusion: null,
          summary: `patch-bound proof generation queued for head ${current.head_sha}`,
          reason: "analysis_ready",
          idempotencyKey: `semantic-analysis:${persistedGenerationContext.id}`,
        });
        await client.query(
          `INSERT INTO audit_events
             (actor_id, action, object_type, object_id, metadata)
           SELECT 'analysis-worker', 'analysis.semantic_generation_queued',
                  'revision', $1, $2::jsonb
           WHERE NOT EXISTS (
             SELECT 1 FROM audit_events
              WHERE action = 'analysis.semantic_generation_queued'
                AND object_type = 'revision' AND object_id = $1
           )`,
          [
            current.revision_id,
            JSON.stringify({
              headSha: current.head_sha,
              generationContextId: persistedGenerationContext.id,
              questionBudget: proofBudget.questionBudget,
            }),
          ],
        );
      }
      await client.query("COMMIT");
      return {
        outcome:
          scheduled === "created"
            ? "semantic_generation_queued"
            : "semantic_generation_replayed",
        revisionId: current.revision_id,
        headSha: current.head_sha,
        generationContextId: persistedGenerationContext.id,
      };
    }

    const proof = planProof(
      {
        analysis,
        policy,
        serverSeed: sha256(
          `proof-plan:${context.revision_id}:${context.head_sha}`,
        ),
        versions: {
          planner: "proof-planner-v1",
          questionTemplates: "proof-questions-v1",
        },
      },
      { clock: { now: () => context.received_at } },
    );
    await client.query(
      `INSERT INTO proof_plans
        (id, revision_id, generation_context_id, repository_policy_id, plan_version,
         deterministic_seed, risk_explanation, question_budget, plan_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'ready')
       ON CONFLICT (id) DO NOTHING`,
      [
        proof.id,
        current.revision_id,
        persistedGenerationContext.id,
        frozenPolicyId,
        proof.plannerVersion,
        proof.seedCommitment,
        JSON.stringify({
          title: `PR #${String(current.pull_request_number)}`,
          riskLevel: proof.riskLevel,
          rationale: proof.rationale,
        }),
        proof.questionBudget,
        proof.planHash,
      ],
    );
    const persistedPlan = await client.query<{
      plan_hash: string;
      repository_policy_id: string;
      generation_context_id: string | null;
    }>(
      `SELECT plan_hash, repository_policy_id, generation_context_id
         FROM proof_plans WHERE id = $1`,
      [proof.id],
    );
    if (
      persistedPlan.rows[0]?.plan_hash !== proof.planHash ||
      persistedPlan.rows[0]?.repository_policy_id !== frozenPolicyId ||
      persistedPlan.rows[0]?.generation_context_id !==
        persistedGenerationContext.id
    ) {
      throw new Error("Deterministic proof plan conflicts with persisted data");
    }
    for (const question of proof.questions) {
      assertProofQuestionAnchor(question.anchor, generationContext);
      await client.query(
        `INSERT INTO proof_questions
          (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, true)
         ON CONFLICT (proof_plan_id, ordinal) DO NOTHING`,
        [
          question.id,
          proof.id,
          question.order - 1,
          question.intent,
          question.prompt,
          JSON.stringify(question.anchor),
          JSON.stringify(question.rubric),
        ],
      );
    }
    await assertPersistedProofQuestions(client, proof.id, proof.questions);

    const active = await client.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM attempts
       WHERE revision_id = $1 AND author_id = $2
         AND status = ANY($3::attempt_status[])
       ORDER BY created_at DESC LIMIT 1`,
      [current.revision_id, current.author_id, ACTIVE_ATTEMPT_STATUSES],
    );
    let attemptId = active.rows[0]?.id;
    let expiresAt = active.rows[0]?.expires_at;
    let created = false;
    if (!attemptId || !expiresAt) {
      const history = await client.query<{
        id: string;
        status: string;
        ordinal: number;
      }>(
        `SELECT id, status,
                count(*) OVER ()::int AS ordinal
         FROM attempts
         WHERE revision_id = $1 AND author_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [current.revision_id, current.author_id],
      );
      const latest = history.rows[0];
      if (latest && latest.status !== "invalidated") {
        await client.query("COMMIT");
        return {
          outcome: "replayed",
          attemptId: latest.id,
          revisionId: current.revision_id,
          headSha: current.head_sha,
        };
      }
      const ordinal = (latest?.ordinal ?? 0) + 1;
      attemptId = deterministicUuid(
        `attempt:${current.revision_id}:${current.author_id}:${proof.id}:${String(ordinal)}`,
      );
      expiresAt = new Date(now.getTime() + 8 * 60 * 60_000);
      await client.query(
        `INSERT INTO attempts
          (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
           status, nonce_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          attemptId,
          current.repository_id,
          current.revision_id,
          current.author_id,
          proof.id,
          current.head_sha,
          sha256(`attempt-nonce:${attemptId}`),
          expiresAt,
        ],
      );
      created = true;
    }

    await scheduleJobInPgTransaction(
      dependencies.queue,
      client,
      "proof.expire-attempt",
      {
        schemaVersion: "1",
        idempotencyKey: `attempt-expiry:${attemptId}:${current.head_sha}`,
        attemptId,
        expectedHeadSha: current.head_sha,
      },
      expiresAt,
    );
    await dependencies.checkIntents.write(client, {
      revisionId: current.revision_id,
      headSha: current.head_sha,
      status: "in_progress",
      conclusion: null,
      summary: `proof ready for head ${current.head_sha}`,
      reason: "analysis_ready",
      idempotencyKey: payload.idempotencyKey,
    });
    await insertAuditOnce(client, {
      action: "analysis.proof_ready",
      objectId: attemptId,
      metadata: {
        revisionId: current.revision_id,
        headSha: current.head_sha,
        planId: proof.id,
      },
    });
    await client.query("COMMIT");
    return {
      outcome: created ? "ready" : "replayed",
      attemptId,
      revisionId: current.revision_id,
      headSha: current.head_sha,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Job boundary for deterministic preparation failures. Infrastructure errors
 * remain retryable; a content/schema/programming failure is persisted once as
 * a fail-closed Check result instead of exhausting the queue invisibly.
 */
export async function prepareRevisionFailClosed(
  rawPayload: JobPayload<"analysis.prepare-revision">,
  dependencies: PrepareRevisionDependencies,
): Promise<PrepareRevisionResult> {
  const payload = parseJobPayload("analysis.prepare-revision", rawPayload);
  try {
    return await prepareRevision(payload, dependencies);
  } catch (error) {
    if (isRetryablePreparationError(error)) throw error;
    return persistPreparationFailure(payload, dependencies, error);
  }
}

async function persistPreparationFailure(
  payload: JobPayload<"analysis.prepare-revision">,
  dependencies: Pick<PrepareRevisionDependencies, "pool" | "checkIntents">,
  error: unknown,
): Promise<PrepareRevisionResult> {
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const revision = await client.query<{
      head_sha: string;
      is_current: boolean;
      pull_request_state: string;
    }>(
      `SELECT revision.head_sha, revision.is_current,
              pull_request.state AS pull_request_state
         FROM pull_request_revisions revision
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
        WHERE revision.id = $1
        FOR UPDATE OF revision, pull_request`,
      [payload.revisionId],
    );
    const current = revision.rows[0];
    if (
      current === undefined ||
      !current.is_current ||
      current.head_sha !== payload.expectedHeadSha
    ) {
      await client.query("ROLLBACK");
      return { outcome: "stale" };
    }
    if (current.pull_request_state !== "open") {
      await client.query("ROLLBACK");
      return { outcome: "closed" };
    }
    await dependencies.checkIntents.write(client, {
      revisionId: payload.revisionId,
      headSha: payload.expectedHeadSha,
      status: "completed",
      conclusion: "action_required",
      summary: `UnderstandProof could not prepare patch-bound questions for head ${payload.expectedHeadSha}. Maintainer action is required.`,
      reason: "preparation_failed",
      idempotencyKey: `analysis-preparation-failed:${payload.revisionId}`,
    });
    await client.query(
      `INSERT INTO audit_events
         (actor_id, action, object_type, object_id, metadata)
       SELECT 'analysis-worker', 'analysis.preparation_failed',
              'revision', $1, $2::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_events
          WHERE action = 'analysis.preparation_failed'
            AND object_type = 'revision' AND object_id = $1
       )`,
      [
        payload.revisionId,
        JSON.stringify({
          headSha: payload.expectedHeadSha,
          errorClass: safeErrorClass(error),
        }),
      ],
    );
    await client.query("COMMIT");
    return {
      outcome: "preparation_failed",
      revisionId: payload.revisionId,
      headSha: payload.expectedHeadSha,
    };
  } catch (failurePersistenceError) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw failurePersistenceError;
  } finally {
    client.release();
  }
}

const RETRYABLE_ERROR_CODES = new Set([
  "40001",
  "40P01",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

export function isRetryablePreparationError(
  error: unknown,
  seen: Set<unknown> = new Set(),
): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    cause?: unknown;
  };
  if (candidate.name === "AbortError") return true;
  if (
    typeof candidate.code === "string" &&
    (candidate.code.startsWith("08") ||
      candidate.code.startsWith("53") ||
      candidate.code.startsWith("58") ||
      RETRYABLE_ERROR_CODES.has(candidate.code))
  ) {
    return true;
  }
  if (
    typeof candidate.status === "number" &&
    (candidate.status === 408 ||
      candidate.status === 425 ||
      candidate.status === 429 ||
      candidate.status >= 500)
  ) {
    return true;
  }
  return isRetryablePreparationError(candidate.cause, seen);
}

export function safeErrorClass(error: unknown): string {
  if (
    error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(error.name)
  ) {
    return error.name;
  }
  return "UnknownError";
}

const REVISION_CONTEXT_SQL = `
  SELECT revision.id AS revision_id, repository.id AS repository_id,
         repository.owner, repository.name AS repository_name,
         repository.active_policy_version, pull_request.number AS pull_request_number,
         pull_request.github_pull_request_id, pull_request.author_id,
         pull_request.state AS pull_request_state,
         revision.base_sha, revision.head_sha, revision.is_current,
         revision.received_at
  FROM pull_request_revisions revision
  JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
  JOIN repositories repository ON repository.id = pull_request.repository_id
  WHERE true`;

async function loadRevisionContext(
  pool: Pool,
  revisionId: string,
): Promise<RevisionContext | undefined> {
  const result = await pool.query<RevisionContext>(
    `${REVISION_CONTEXT_SQL} AND revision.id = $1`,
    [revisionId],
  );
  return result.rows[0];
}

async function loadRequiredBoundedSource(
  source: RevisionPatchSource,
  request: RevisionPatchRequest,
): Promise<BoundedRevisionSourceV1> {
  if (!("loadBoundedSource" in source)) {
    throw new Error(
      "Production revision preparation requires an immutable bounded source",
    );
  }
  const loadBoundedSource = Reflect.get(source, "loadBoundedSource");
  if (typeof loadBoundedSource !== "function") {
    throw new Error(
      "Production revision preparation requires an immutable bounded source",
    );
  }
  return BoundedRevisionSourceV1Schema.parse(
    await Reflect.apply(loadBoundedSource, source, [request]),
  );
}

async function loadOptionalImmutableSource(
  source: RevisionPatchSource,
  request: RevisionPatchRequest,
): Promise<GithubRevisionSourceV1 | undefined> {
  if (!("loadImmutableSource" in source)) return undefined;
  const loadImmutableSource = Reflect.get(source, "loadImmutableSource");
  if (typeof loadImmutableSource !== "function") return undefined;
  return GithubRevisionSourceV1Schema.parse(
    await Reflect.apply(loadImmutableSource, source, [request]),
  );
}

async function persistAnalysisSnapshotExactlyOnce(
  client: PoolClient,
  revisionId: string,
  analysis: AnalysisSnapshot,
  diffHash: string,
): Promise<string> {
  const inserted = await client.query<{
    id: string;
    snapshot: unknown;
    status: string;
  }>(
    `INSERT INTO analysis_snapshots
       (revision_id, analyzer_version, diff_hash, snapshot, status)
     VALUES ($1, $2, $3, $4::jsonb, 'ready')
     ON CONFLICT (revision_id, analyzer_version, diff_hash) DO NOTHING
     RETURNING id, snapshot, status`,
    [revisionId, analysis.analyzerVersion, diffHash, JSON.stringify(analysis)],
  );
  const persisted =
    inserted.rows.length === 1
      ? inserted
      : await client.query<{
          id: string;
          snapshot: unknown;
          status: string;
        }>(
          `SELECT id, snapshot, status
             FROM analysis_snapshots
            WHERE revision_id = $1
              AND analyzer_version = $2
              AND diff_hash = $3
            LIMIT 2
            FOR SHARE`,
          [revisionId, analysis.analyzerVersion, diffHash],
        );
  const row = persisted.rows.length === 1 ? persisted.rows[0] : undefined;
  const snapshot = AnalysisSnapshotSchema.safeParse(row?.snapshot);
  if (
    !row ||
    row.status !== "ready" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      row.id,
    ) ||
    !snapshot.success ||
    stableJson(snapshot.data) !== stableJson(analysis)
  ) {
    throw new Error("Analysis snapshot conflicts with persisted data");
  }
  return row.id;
}

async function loadPolicy(
  pool: Pool,
  context: RevisionContext,
): Promise<RepositoryPolicyV1> {
  const result = await pool.query<{ policy: unknown }>(
    `SELECT policy FROM repository_policies
     WHERE repository_id = $1 AND version = $2`,
    [context.repository_id, context.active_policy_version],
  );
  if (!result.rows[0]) {
    if (context.active_policy_version !== 1) {
      throw new Error("The active repository policy is missing");
    }
    return DEFAULT_REPOSITORY_POLICY_V1;
  }
  return RepositoryPolicyV1Schema.parse(result.rows[0].policy);
}

async function ensureDefaultPolicy(
  client: PoolClient,
  context: RevisionContext,
  policy: RepositoryPolicyV1,
  now: Date,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM repository_policies
     WHERE repository_id = $1 AND version = $2`,
    [context.repository_id, context.active_policy_version],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  if (
    context.active_policy_version !== 1 ||
    JSON.stringify(policy) !== JSON.stringify(DEFAULT_REPOSITORY_POLICY_V1)
  ) {
    throw new Error("The active repository policy disappeared during analysis");
  }
  const serialized = JSON.stringify(DEFAULT_REPOSITORY_POLICY_V1);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO repository_policies
      (repository_id, version, schema_version, policy, policy_hash,
       created_by, activated_at)
     VALUES ($1, 1, '1', $2::jsonb, $3, 'system-default', $4)
     ON CONFLICT (repository_id, version) DO NOTHING
     RETURNING id`,
    [context.repository_id, serialized, sha256(serialized), now],
  );
  const raced = inserted.rows[0]
    ? inserted
    : await client.query<{ id: string }>(
        `SELECT id FROM repository_policies
         WHERE repository_id = $1 AND version = $2`,
        [context.repository_id, context.active_policy_version],
      );
  const id = raced.rows[0]?.id;
  if (!id) throw new Error("Could not freeze the repository policy");
  return id;
}

async function insertAuditOnce(
  client: PoolClient,
  input: {
    action: string;
    objectId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (actor_id, action, object_type, object_id, metadata)
     SELECT 'analysis-worker', $1, 'attempt', $2, $3::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_events
       WHERE action = $1 AND object_type = 'attempt' AND object_id = $2
     )`,
    [input.action, input.objectId, JSON.stringify(input.metadata)],
  );
}

function assertProofQuestionAnchor(
  anchor: ProofQuestion["anchor"],
  context: GenerationContextV1,
): void {
  const exact = context.anchors.find((candidate) => candidate.id === anchor.id);
  if (
    !exact ||
    exact.filename.content !== anchor.file ||
    exact.hunkHeader.content !== anchor.hunkHeader ||
    exact.oldStart !== anchor.oldStart ||
    exact.newStart !== anchor.newStart ||
    exact.changedLines !== anchor.changedLines
  ) {
    throw new Error("Proof question anchor is outside the generation context");
  }
}

async function assertPersistedProofQuestions(
  client: PoolClient,
  proofPlanId: string,
  questions: readonly ProofQuestion[],
): Promise<void> {
  const persisted = await client.query<{
    id: string;
    ordinal: number;
    type: string;
    prompt: string;
    diff_anchor: unknown;
    rubric: unknown;
    required: boolean;
  }>(
    `SELECT id, ordinal, type, prompt, diff_anchor, rubric, required
       FROM proof_questions
      WHERE proof_plan_id = $1
      ORDER BY ordinal`,
    [proofPlanId],
  );
  const expected = questions.map((question) => ({
    id: question.id,
    ordinal: question.order - 1,
    type: question.intent,
    prompt: question.prompt,
    diff_anchor: question.anchor,
    rubric: question.rubric,
    required: true,
  }));
  if (stableJson(persisted.rows) !== stableJson(expected)) {
    throw new Error("Proof questions conflict with persisted data");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
  return `{${entries.join(",")}}`;
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
