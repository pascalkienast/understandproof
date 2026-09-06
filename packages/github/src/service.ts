import type { Pool, PoolClient } from "pg";
import {
  persistGithubRevisionSourceInTransaction,
  persistGithubCheckIntentInTransaction,
  reactivateInactiveGithubCheckIntentInTransaction,
  type GithubCheckOutbox,
  type GithubRevisionSource,
  type JobPayload,
} from "@understandproof/db";
import {
  PublicCheckInputSchema,
  PullRequestJobPayloadSchema,
  type PublicCheckInput,
  type PullRequestJobPayload,
} from "./schemas";
import { GITHUB_CHECK_NAME } from "./production-ports";

export class WebhookDeliveryConflictError extends Error {
  readonly code = "WEBHOOK_DELIVERY_CONFLICT" as const;
}

export class InactiveGithubInstallationError extends Error {
  readonly code = "INACTIVE_GITHUB_INSTALLATION" as const;

  constructor() {
    super("GitHub installation is not an active tenant");
    this.name = "InactiveGithubInstallationError";
  }
}

export type WebhookReservation = {
  duplicate: boolean;
  shouldEnqueue: boolean;
};

type SqlExecutor = Pick<Pool, "query">;

export async function reserveWebhookDelivery(
  pool: SqlExecutor,
  input: { deliveryId: string; eventName: string; payloadHash: string },
): Promise<WebhookReservation> {
  const inserted = await pool.query(
    `INSERT INTO webhook_deliveries (delivery_id, event_name, payload_hash, processing_status)
     VALUES ($1, $2, $3, 'reserved')
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING delivery_id`,
    [input.deliveryId, input.eventName, input.payloadHash],
  );
  if (inserted.rowCount === 1) return { duplicate: false, shouldEnqueue: true };

  const existing = await pool.query<{
    payload_hash: string;
    processing_status: string;
    event_name: string;
    reclaimable: boolean;
  }>(
    `SELECT payload_hash, processing_status, event_name,
            processing_status = 'queued' AND (
              (next_retry_at IS NOT NULL AND next_retry_at <= now())
              OR (next_retry_at IS NULL
                  AND queued_at < now() - interval '2 minutes')
            ) AS reclaimable
       FROM webhook_deliveries
      WHERE delivery_id = $1
      FOR UPDATE`,
    [input.deliveryId],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.payload_hash !== input.payloadHash ||
    row.event_name !== input.eventName
  ) {
    throw new WebhookDeliveryConflictError(
      "Delivery ID was reused with a different payload",
    );
  }
  return {
    duplicate: true,
    shouldEnqueue:
      row.processing_status === "reserved" || row.reclaimable === true,
  };
}

export async function markWebhookQueued(
  pool: SqlExecutor,
  deliveryId: string,
): Promise<void> {
  await pool.query(
    `UPDATE webhook_deliveries
     SET processing_status = CASE WHEN processing_status = 'processed' THEN processing_status ELSE 'queued' END
       , queued_at = CASE WHEN processing_status = 'processed' THEN NULL ELSE now() END
       , next_retry_at = NULL
     WHERE delivery_id = $1`,
    [deliveryId],
  );
}

export type GithubCheckIntentWriterInput = PublicCheckInput & {
  idempotencyKey: string;
  reason: JobPayload<"github.reconcile-check">["reason"];
};

export interface GithubCheckPort {
  readonly requiresVerifiedRevisionSource: boolean;
  detailsUrl(revisionId: string): string;
  write(client: PoolClient, input: GithubCheckIntentWriterInput): Promise<void>;
  reactivateInactive?(
    client: PoolClient,
    revisionId: string,
    expectedHeadSha: string,
  ): Promise<boolean>;
}

export interface RevisionPreparationPublisher {
  publish(
    client: PoolClient,
    payload: JobPayload<"analysis.prepare-revision">,
  ): Promise<string | null>;
  publishAttemptExpiry?(
    client: PoolClient,
    payload: JobPayload<"proof.expire-attempt">,
  ): Promise<string | null>;
}

export class PostgresGithubCheckIntentWriter implements GithubCheckPort {
  constructor(
    private readonly outbox: GithubCheckOutbox,
    private readonly baseUrl: string,
    readonly requiresVerifiedRevisionSource = true,
  ) {}

  detailsUrl(revisionId: string): string {
    return new URL(`/revisions/${revisionId}`, this.baseUrl).toString();
  }

  async write(
    client: PoolClient,
    input: GithubCheckIntentWriterInput,
  ): Promise<void> {
    await persistGithubCheckIntentInTransaction(client, this.outbox, {
      revisionId: input.revisionId,
      expectedHeadSha: input.headSha,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      name: GITHUB_CHECK_NAME,
      status: input.status,
      conclusion: input.conclusion,
      publicSummary: input.summary,
      detailsUrl: this.detailsUrl(input.revisionId),
    });
  }

  async reactivateInactive(
    client: PoolClient,
    revisionId: string,
    expectedHeadSha: string,
  ): Promise<boolean> {
    return reactivateInactiveGithubCheckIntentInTransaction(
      client,
      this.outbox,
      revisionId,
      expectedHeadSha,
    );
  }
}

export class FakeGithubCheckAdapter implements GithubCheckPort {
  readonly requiresVerifiedRevisionSource = false;
  constructor(
    private readonly pool: Pool,
    private readonly baseUrl: string,
  ) {}

  detailsUrl(revisionId: string): string {
    return new URL(`/revisions/${revisionId}`, this.baseUrl).toString();
  }

  async write(
    client: PoolClient,
    rawInput: GithubCheckIntentWriterInput,
  ): Promise<void> {
    const input = PublicCheckInputSchema.parse({
      revisionId: rawInput.revisionId,
      headSha: rawInput.headSha,
      status: rawInput.status,
      conclusion: rawInput.conclusion,
      summary: rawInput.summary,
      detailsUrl: rawInput.detailsUrl,
    });
    const executor = client;
    await executor.query(
      `INSERT INTO check_runs
        (revision_id, github_check_run_id, name, status, conclusion, public_summary, details_url)
       VALUES ($1, $2, $7, $3, $4, $5, $6)
       ON CONFLICT (revision_id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         conclusion = EXCLUDED.conclusion,
         public_summary = EXCLUDED.public_summary,
         details_url = EXCLUDED.details_url,
         last_synchronized_at = now(),
         updated_at = now()`,
      [
        input.revisionId,
        `fake-check:${input.revisionId}`,
        input.status,
        input.conclusion,
        input.summary,
        input.detailsUrl,
        GITHUB_CHECK_NAME,
      ],
    );
  }
}

export type ProcessPullRequestResult = {
  revisionId: string;
  createdRevision: boolean;
  invalidatedAttempts: number;
};

type GithubLifecycleState = "active" | "pending" | "suspended" | "removed";

export type GithubLifecycleAuthorizationFence = {
  freshAuthorization: boolean;
  installation: {
    githubInstallationId: string;
    status: GithubLifecycleState;
    version: string;
  } | null;
  repository: {
    githubRepositoryId: string;
    githubInstallationId: string;
    status: GithubLifecycleState;
    owner: string;
    name: string;
    version: string;
  } | null;
};

export type VerifiedGithubRevisionSource = {
  source: GithubRevisionSource;
  fetchedAt: Date;
  authorizationFence?: GithubLifecycleAuthorizationFence;
};

const VerifiedPullRequestSnapshotSchema = PullRequestJobPayloadSchema.omit({
  deliveryId: true,
  eventName: true,
});

export type VerifiedPullRequestSnapshot = Omit<
  PullRequestJobPayload,
  "deliveryId" | "eventName"
>;

export async function processPullRequestJob(
  pool: Pool,
  checkPort: GithubCheckPort,
  rawPayload: PullRequestJobPayload,
  revisionPublisher?: RevisionPreparationPublisher,
  revisionSource?: VerifiedGithubRevisionSource,
): Promise<ProcessPullRequestResult> {
  const payload = PullRequestJobPayloadSchema.parse(rawPayload);
  return processVerifiedPullRequestSnapshotOperation(
    pool,
    checkPort,
    payload,
    revisionPublisher,
    revisionSource,
    payload.deliveryId,
  );
}

/** Reconciles one freshly verified GitHub snapshot without fabricating a webhook delivery. */
export async function processVerifiedPullRequestSnapshot(
  pool: Pool,
  checkPort: GithubCheckPort,
  rawPayload: VerifiedPullRequestSnapshot,
  revisionPublisher?: RevisionPreparationPublisher,
  revisionSource?: VerifiedGithubRevisionSource,
): Promise<ProcessPullRequestResult> {
  const payload = VerifiedPullRequestSnapshotSchema.parse(rawPayload);
  return processVerifiedPullRequestSnapshotOperation(
    pool,
    checkPort,
    payload,
    revisionPublisher,
    revisionSource,
  );
}

async function processVerifiedPullRequestSnapshotOperation(
  pool: Pool,
  checkPort: GithubCheckPort,
  payload: VerifiedPullRequestSnapshot,
  revisionPublisher?: RevisionPreparationPublisher,
  revisionSource?: VerifiedGithubRevisionSource,
  deliveryId?: string,
): Promise<ProcessPullRequestResult> {
  if (checkPort.requiresVerifiedRevisionSource && !revisionSource) {
    throw new Error("A freshly verified GitHub revision source is required");
  }
  if (
    checkPort.requiresVerifiedRevisionSource &&
    !revisionSource?.authorizationFence
  ) {
    throw new Error("A lifecycle authorization fence is required");
  }
  if (
    revisionSource &&
    (revisionSource.source.githubPullRequestId !==
      payload.pullRequest.githubPullRequestId ||
      revisionSource.source.number !== payload.pullRequest.number ||
      revisionSource.source.authorId !== payload.pullRequest.authorId ||
      revisionSource.source.headSha !== payload.pullRequest.headSha ||
      revisionSource.source.baseSha !== payload.pullRequest.baseSha ||
      revisionSource.source.state !== payload.pullRequest.state)
  ) {
    throw new Error("Verified GitHub revision source does not match the job");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const authorizationFence = revisionSource?.authorizationFence;
    const installationFence = authorizationFence?.installation ?? null;
    const repositoryFence = authorizationFence?.repository ?? null;
    const repositoryBindingMoved =
      repositoryFence !== null &&
      repositoryFence.githubInstallationId !==
        payload.installation.githubInstallationId;
    let recoveryPullRequestId: string | null = null;
    if (
      authorizationFence?.freshAuthorization === true &&
      repositoryBindingMoved
    ) {
      const recoveryWinner = await client.query<{ id: string }>(
        `SELECT pull_request.id
           FROM pull_requests pull_request
           JOIN repositories repository
             ON repository.id = pull_request.repository_id
           JOIN github_recovery_candidates candidate
             ON candidate.pull_request_id = pull_request.id
            AND candidate.github_installation_id = $3
          WHERE pull_request.github_pull_request_id = $1
            AND repository.github_repository_id = $2
            AND pull_request.github_recovery_binding->>'installationId' = $3
            AND candidate.account_id = $4
            AND candidate.account_login = $5
            AND candidate.owner = $6
            AND candidate.repository_name = $7
          FOR UPDATE OF pull_request, candidate`,
        [
          payload.pullRequest.githubPullRequestId,
          payload.repository.githubRepositoryId,
          payload.installation.githubInstallationId,
          payload.installation.accountId,
          payload.installation.accountLogin,
          payload.repository.owner,
          payload.repository.name,
        ],
      );
      recoveryPullRequestId = recoveryWinner.rows[0]?.id ?? null;
      if (!recoveryPullRequestId) {
        throw new Error("GitHub recovery winner changed before activation");
      }
    }
    const mayReactivateInstallation =
      authorizationFence?.freshAuthorization === true &&
      installationFence !== null &&
      installationFence.status === "suspended";
    const installation = await client.query<{ id: string; status: string }>(
      `UPDATE installations
          SET account_id = $2,
              account_login = $3,
              status = CASE WHEN $4::boolean THEN 'active'::github_lifecycle_status
                            ELSE installations.status END,
              suspended_at = CASE WHEN $4::boolean THEN NULL
                                  ELSE installations.suspended_at END,
              updated_at = CASE
                WHEN installations.account_id IS DISTINCT FROM $2
                  OR installations.account_login IS DISTINCT FROM $3
                  OR ($4::boolean AND installations.status <> 'active')
                THEN now() ELSE installations.updated_at END
        WHERE github_installation_id = $1
          AND installations.status <> 'removed'
          AND installations.status <> 'pending'
          AND (
            ($5::text IS NULL AND installations.status = 'active')
            OR (
              installations.status::text = $6
              AND installations.updated_at::text = $5
              AND (installations.status = 'active' OR $4::boolean)
            )
          )
        RETURNING id, status`,
      [
        payload.installation.githubInstallationId,
        payload.installation.accountId,
        payload.installation.accountLogin,
        mayReactivateInstallation,
        installationFence?.version ?? null,
        installationFence?.status ?? null,
      ],
    );
    if (installation.rows[0]?.status !== "active") {
      throw new InactiveGithubInstallationError();
    }
    const mayReactivateRepository =
      authorizationFence?.freshAuthorization === true &&
      repositoryFence !== null &&
      (repositoryFence.status !== "active" || repositoryBindingMoved);
    const repository = await client.query<{ id: string; status: string }>(
      `INSERT INTO repositories
        (installation_id, github_repository_id, owner, name, default_branch)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_repository_id) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         owner = EXCLUDED.owner,
         name = EXCLUDED.name,
         default_branch = EXCLUDED.default_branch,
         status = CASE WHEN $6::boolean THEN 'active'::github_lifecycle_status
                       ELSE repositories.status END,
         suspended_at = CASE WHEN $6::boolean THEN NULL
                             ELSE repositories.suspended_at END,
         removed_at = CASE WHEN $6::boolean THEN NULL
                           ELSE repositories.removed_at END,
         updated_at = CASE
           WHEN repositories.installation_id IS DISTINCT FROM EXCLUDED.installation_id
             OR repositories.owner IS DISTINCT FROM EXCLUDED.owner
             OR repositories.name IS DISTINCT FROM EXCLUDED.name
             OR repositories.default_branch IS DISTINCT FROM EXCLUDED.default_branch
             OR ($6::boolean AND repositories.status <> 'active')
           THEN now() ELSE repositories.updated_at END
       WHERE (repositories.status <> 'removed' OR $6::boolean)
         AND (
           (
             $7::text IS NULL
             AND repositories.status = 'active'
             AND repositories.installation_id = EXCLUDED.installation_id
           )
           OR (
             repositories.status::text = $8
             AND repositories.updated_at::text = $7
             AND repositories.owner = $9
             AND repositories.name = $10
             AND repositories.installation_id = (
               SELECT id FROM installations
                WHERE github_installation_id = $11
             )
             AND (
               (repositories.status = 'active'
                AND repositories.installation_id = EXCLUDED.installation_id)
               OR $6::boolean
             )
           )
         )
       RETURNING id, status`,
      [
        installation.rows[0]!.id,
        payload.repository.githubRepositoryId,
        payload.repository.owner,
        payload.repository.name,
        payload.repository.defaultBranch,
        mayReactivateRepository,
        repositoryFence?.version ?? null,
        repositoryFence?.status ?? null,
        repositoryFence?.owner ?? null,
        repositoryFence?.name ?? null,
        repositoryFence?.githubInstallationId ?? null,
      ],
    );
    if (repository.rows[0]?.status !== "active") {
      throw new Error("GitHub repository is not active");
    }
    const pullRequest = await client.query<{ id: string }>(
      `INSERT INTO pull_requests
        (repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_pull_request_id) DO UPDATE SET
         author_id = EXCLUDED.author_id,
         state = EXCLUDED.state,
         next_github_refresh_at = CASE
           WHEN EXCLUDED.state = 'open' THEN now() + interval '2 minutes'
           ELSE NULL
         END,
         updated_at = now()
       RETURNING id`,
      [
        repository.rows[0]!.id,
        payload.pullRequest.githubPullRequestId,
        payload.pullRequest.number,
        payload.pullRequest.authorId,
        payload.pullRequest.state,
      ],
    );
    await client.query(
      `UPDATE pull_requests
          SET next_github_refresh_at = CASE
                WHEN state = 'open' THEN now() + interval '2 minutes'
                ELSE NULL
              END
        WHERE id = $1 AND next_github_refresh_at IS NULL`,
      [pullRequest.rows[0]!.id],
    );
    await client.query(
      "SELECT id FROM pull_requests WHERE id = $1 FOR UPDATE",
      [pullRequest.rows[0]!.id],
    );
    if (
      recoveryPullRequestId !== null &&
      recoveryPullRequestId !== pullRequest.rows[0]!.id
    ) {
      throw new Error("GitHub recovery pull request changed before activation");
    }
    const clearedRecovery = await client.query(
      `UPDATE pull_requests
          SET github_recovery_binding = NULL
        WHERE id = $1
          AND github_recovery_binding->>'installationId' = $2`,
      [pullRequest.rows[0]!.id, payload.installation.githubInstallationId],
    );
    if (recoveryPullRequestId !== null && clearedRecovery.rowCount !== 1) {
      throw new Error("GitHub recovery winner changed before activation");
    }
    await client.query(
      "DELETE FROM github_recovery_candidates WHERE pull_request_id = $1",
      [pullRequest.rows[0]!.id],
    );

    const current = await client.query<{
      id: string;
      head_sha: string;
      base_sha: string;
    }>(
      `SELECT id, head_sha, base_sha FROM pull_request_revisions
       WHERE pull_request_id = $1 AND is_current = true FOR UPDATE`,
      [pullRequest.rows[0]!.id],
    );

    let revisionId = current.rows[0]?.id;
    let createdRevision = false;
    let reactivatedRevision = false;
    let invalidatedAttempts = 0;
    const invalidatedForCleanup: { id: string; head_sha: string }[] = [];
    if (
      current.rows[0]?.head_sha !== payload.pullRequest.headSha ||
      current.rows[0]?.base_sha !== payload.pullRequest.baseSha
    ) {
      if (current.rows[0]) {
        await client.query(
          `UPDATE pull_request_revisions
           SET is_current = false, invalidated_at = now()
           WHERE id = $1`,
          [current.rows[0].id],
        );
        const invalidated = await client.query<{
          id: string;
          head_sha: string;
        }>(
          `UPDATE attempts
           SET status = 'invalidated', invalidated_at = now(), completed_at = now(), updated_at = now()
           WHERE revision_id = $1
             AND status IN ('preparing','ready','active','uploading','processing','review_required')
           RETURNING id, head_sha`,
          [current.rows[0].id],
        );
        invalidatedAttempts = invalidated.rowCount ?? 0;
        invalidatedForCleanup.push(...invalidated.rows);
        await checkPort.write(client, {
          revisionId: current.rows[0].id,
          headSha: current.rows[0].head_sha,
          status: "completed",
          conclusion: "cancelled",
          summary: "invalidated by a newer head SHA",
          detailsUrl: checkPort.detailsUrl(current.rows[0].id),
          idempotencyKey: `check:invalidated:${current.rows[0].id}:${payload.pullRequest.headSha}`,
          reason: "revision_invalidated",
        });
      }
      const insertedRevision = await client.query<{ id: string }>(
        `INSERT INTO pull_request_revisions (pull_request_id, head_sha, base_sha, is_current)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (pull_request_id, head_sha, base_sha) DO UPDATE SET
           is_current = true,
           invalidated_at = NULL
         RETURNING id`,
        [
          pullRequest.rows[0]!.id,
          payload.pullRequest.headSha,
          payload.pullRequest.baseSha,
        ],
      );
      revisionId = insertedRevision.rows[0]!.id;
      createdRevision = true;
      reactivatedRevision = current.rows[0] !== undefined;
    }

    if (!revisionId) throw new Error("Pull request revision was not created");
    const lifecycleReactivated =
      mayReactivateInstallation || mayReactivateRepository;
    if (payload.action === "closed") {
      const invalidated = await client.query<{
        id: string;
        head_sha: string;
      }>(
        `UPDATE attempts
         SET status = 'invalidated', invalidated_at = now(),
             completed_at = now(), updated_at = now()
         WHERE revision_id = $1
           AND status IN ('preparing','ready','active','uploading','processing','review_required')
         RETURNING id, head_sha`,
        [revisionId],
      );
      invalidatedAttempts += invalidated.rowCount ?? 0;
      invalidatedForCleanup.push(...invalidated.rows);
    }
    const passed = await client.query(
      `SELECT 1 FROM attempts
       WHERE revision_id = $1 AND status = 'passed'
       LIMIT 1`,
      [revisionId],
    );
    const alreadyPassed = payload.action !== "closed" && passed.rowCount === 1;
    if (revisionSource && payload.action !== "closed") {
      await persistGithubRevisionSourceInTransaction(client, {
        revisionId,
        source: revisionSource.source,
        fetchedAt: revisionSource.fetchedAt,
      });
    }

    const currentCheck = await client.query<{
      intent_reason: string | null;
      status: string;
      conclusion: string | null;
    }>(
      `SELECT intent_reason, status, conclusion
         FROM check_runs
        WHERE revision_id = $1
        FOR UPDATE`,
      [revisionId],
    );
    const checkRow = currentCheck.rows[0];
    if (lifecycleReactivated && checkPort.reactivateInactive) {
      await checkPort.reactivateInactive(
        client,
        revisionId,
        payload.pullRequest.headSha,
      );
    }
    const canApplyWebhookCheck =
      payload.action === "closed" ||
      alreadyPassed ||
      reactivatedRevision ||
      !checkRow ||
      checkRow.intent_reason === null ||
      checkRow.intent_reason === "webhook_ingested";
    if (canApplyWebhookCheck) {
      await checkPort.write(client, {
        revisionId,
        headSha: payload.pullRequest.headSha,
        status:
          payload.action === "closed" || alreadyPassed
            ? "completed"
            : "in_progress",
        conclusion:
          payload.action === "closed"
            ? "cancelled"
            : alreadyPassed
              ? "success"
              : null,
        summary:
          payload.action === "closed"
            ? `closed for head ${payload.pullRequest.headSha}`
            : alreadyPassed
              ? `understanding confirmed for head ${payload.pullRequest.headSha}`
              : `understanding required for head ${payload.pullRequest.headSha}`,
        detailsUrl: checkPort.detailsUrl(revisionId),
        idempotencyKey: `check:webhook:${revisionId}:${payload.action}`,
        reason: "webhook_ingested",
      });
    }
    let shouldPrepareRevision = createdRevision || reactivatedRevision;
    if (
      payload.action !== "closed" &&
      revisionPublisher &&
      !shouldPrepareRevision
    ) {
      const prepared = await client.query<{
        has_snapshot: boolean;
        has_plan: boolean;
        has_usable_attempt: boolean;
      }>(
        `SELECT EXISTS (
                  SELECT 1 FROM analysis_snapshots
                   WHERE revision_id = $1 AND status = 'ready'
                ) AS has_snapshot,
                EXISTS (
                  SELECT 1 FROM proof_plans
                   WHERE revision_id = $1 AND status = 'ready'
                ) AS has_plan,
                EXISTS (
                  SELECT 1 FROM attempts
                   WHERE revision_id = $1
                     AND status IN (
                       'preparing','ready','active','uploading','processing',
                       'review_required','passed'
                     )
                ) AS has_usable_attempt`,
        [revisionId],
      );
      const advancedCheck =
        checkRow?.intent_reason !== undefined &&
        checkRow.intent_reason !== null &&
        !["webhook_ingested", "analysis_ready"].includes(
          checkRow.intent_reason,
        );
      shouldPrepareRevision =
        !advancedCheck &&
        (!prepared.rows[0]?.has_snapshot ||
          !prepared.rows[0]?.has_plan ||
          (!alreadyPassed && !prepared.rows[0]?.has_usable_attempt));
    }
    if (
      payload.action !== "closed" &&
      revisionPublisher &&
      shouldPrepareRevision
    ) {
      await revisionPublisher.publish(client, {
        schemaVersion: "1",
        idempotencyKey: `analysis:${revisionId}:${payload.pullRequest.headSha}`,
        revisionId,
        expectedHeadSha: payload.pullRequest.headSha,
      });
    }
    if (revisionPublisher?.publishAttemptExpiry) {
      for (const attempt of invalidatedForCleanup) {
        await revisionPublisher.publishAttemptExpiry(client, {
          schemaVersion: "1",
          idempotencyKey: `invalidation-cleanup:${attempt.id}:${attempt.head_sha}`,
          attemptId: attempt.id,
          expectedHeadSha: attempt.head_sha,
        });
      }
    }
    if (deliveryId) {
      const delivery = await client.query(
        `UPDATE webhook_deliveries
            SET processing_status = 'processed', processed_at = now(),
                queued_at = NULL, next_retry_at = NULL
          WHERE delivery_id = $1
            AND processing_status IN ('reserved', 'queued')`,
        [deliveryId],
      );
      if (delivery.rowCount !== 1) {
        throw new WebhookDeliveryConflictError(
          "Webhook delivery is not reserved for processing",
        );
      }
    }
    await client.query("COMMIT");
    return { revisionId, createdRevision, invalidatedAttempts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
