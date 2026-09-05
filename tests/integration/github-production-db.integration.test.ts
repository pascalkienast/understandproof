import { createHmac } from "node:crypto";
import {
  GithubCheckIntentConflictError,
  GithubRefreshPrJobSchema,
  GithubOauthFlowConflictError,
  GithubRevisionSourceConflictError,
  PgBossGithubCheckOutbox,
  StaleGithubCheckIntentError,
  StaleGithubRevisionSourceError,
  claimGithubCheckSync,
  completeInactiveGithubCheckSync,
  completeGithubCheckSync,
  connectDatabase,
  consumeGithubOauthFlow,
  createGithubOauthFlow,
  failGithubCheckSync,
  loadGithubRevisionSource,
  migrateDatabase,
  persistGithubCheckIntent,
  persistGithubCheckIntentInTransaction,
  persistGithubRevisionSourceInTransaction,
  replayDueGithubCheckSyncs,
  startJobQueue,
  type DatabaseConnection,
  type GithubCheckIntent,
  type GithubCheckOutbox,
} from "@understandproof/db";
import {
  GithubControlError,
  PostgresGithubCheckIntentWriter,
  ingestGithubWebhook,
  processVerifiedPullRequestSnapshot,
  reserveWebhookDelivery,
  type GithubPullRequestHeadPort,
  type GithubPullRequestPort,
  type PullRequestJobPublisher,
} from "@understandproof/github";
import {
  handleGithubRefreshPullRequestJob,
  sweepDueGithubPullRequestDeliveries,
  sweepDueGithubPullRequestRefreshes,
  type GithubControlDependencies,
} from "../../apps/github-control/src/control";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const installationId = "81000000-0000-4000-8000-000000000001";
const repositoryId = "81000000-0000-4000-8000-000000000002";
const pullRequestId = "81000000-0000-4000-8000-000000000003";
const revisionId = "81000000-0000-4000-8000-000000000004";
const headSha = "a".repeat(40);
const recoveryInstallationId = "8201";
const recoveryAccountId = "8202";
const recoveryAccountLogin = "acme-recovery";
const fallbackRecoveryInstallationId = "8301";
const fallbackRecoveryAccountId = "8302";
const fallbackRecoveryAccountLogin = "acme-fallback";
const webhookSecret = "integration-webhook-secret-with-enough-entropy";

databaseDescribe("production GitHub persistence", () => {
  let database: DatabaseConnection;
  let queue: Awaited<ReturnType<typeof startJobQueue>>;
  let outbox: PgBossGithubCheckOutbox;

  beforeAll(async () => {
    database = connectDatabase(databaseUrl!);
    await migrateDatabase(database.pool);
    queue = await startJobQueue(databaseUrl!);
    outbox = new PgBossGithubCheckOutbox(queue);
  });

  afterAll(async () => {
    if (queue) await queue.stop({ graceful: true, timeout: 5_000 });
    if (database) await database.close();
  });

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        github_revision_sources, github_oauth_flows, audit_events, deletion_jobs, check_runs,
        review_decisions, evaluations, frame_selections, transcripts,
        recording_objects, recording_parts, upload_sessions,
        wrapping_materials, handoff_tokens, auth_sessions,
        attempt_transitions, attempts, proof_questions, proof_plans,
        practice_sessions, analysis_snapshots, webhook_deliveries,
        pull_request_revisions, pull_requests, repository_policies,
        repositories, installations, github_app_account_allowlist
      RESTART IDENTITY CASCADE
    `);
    await database.pool.query(
      "DELETE FROM pgboss.job WHERE name = 'github.reconcile-check'",
    );
    await seedGithubAggregate(database);
  });

  it("tombstones installation and repository lifecycle without cascade loss", async () => {
    await database.pool.query(
      `UPDATE installations
          SET status = 'suspended', suspended_at = now(), updated_at = now()
        WHERE id = $1`,
      [installationId],
    );
    expect(await count(database, "repositories")).toBe(1);
    expect(await count(database, "pull_requests")).toBe(1);

    await database.pool.query(
      `UPDATE repositories
          SET status = 'removed', removed_at = now(), updated_at = now()
        WHERE id = $1`,
      [repositoryId],
    );
    await database.pool.query(
      `UPDATE repositories
          SET status = 'active', suspended_at = NULL, removed_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [repositoryId],
    );
    expect(
      await database.pool.query<{ status: string }>(
        "SELECT status FROM repositories WHERE id = $1",
        [repositoryId],
      ),
    ).toMatchObject({ rows: [{ status: "active" }] });
    await database.pool.query(
      `UPDATE repositories
          SET status = 'removed', removed_at = now(), updated_at = now()
        WHERE id = $1`,
      [repositoryId],
    );
    await database.pool.query(
      `UPDATE installations
          SET status = 'removed', removed_at = now(), updated_at = now()
        WHERE id = $1`,
      [installationId],
    );

    await expect(
      database.pool.query("DELETE FROM installations WHERE id = $1", [
        installationId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      database.pool.query(
        `UPDATE installations
            SET status = 'active', suspended_at = NULL, removed_at = NULL
          WHERE id = $1`,
        [installationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await count(database, "repositories")).toBe(1);
    expect(await count(database, "pull_request_revisions")).toBe(1);
  });

  it("stores an added repository without inventing a default branch", async () => {
    const addedRepositoryId = "81000000-0000-4000-8000-000000000005";
    await database.pool.query(
      `INSERT INTO repositories
         (id, installation_id, github_repository_id, owner, name, default_branch)
       VALUES ($1, $2, '8106', 'acme', 'new-repository', NULL)`,
      [addedRepositoryId, installationId],
    );
    await expect(
      database.pool.query<{ default_branch: string | null }>(
        "SELECT default_branch FROM repositories WHERE id = $1",
        [addedRepositoryId],
      ),
    ).resolves.toMatchObject({ rows: [{ default_branch: null }] });

    await database.pool.query(
      "UPDATE repositories SET default_branch = 'trunk' WHERE id = $1",
      [addedRepositoryId],
    );
    await expect(
      database.pool.query<{ default_branch: string | null }>(
        "SELECT default_branch FROM repositories WHERE id = $1",
        [addedRepositoryId],
      ),
    ).resolves.toMatchObject({ rows: [{ default_branch: "trunk" }] });
  });

  it("consumes an allowlisted OAuth state exactly once under concurrency", async () => {
    const stateHash = "b".repeat(64);
    await createGithubOauthFlow(database.pool, {
      stateHash,
      purpose: "maintainer_reauth",
      repositoryId,
      redirectPath: "/review",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    const results = await Promise.all([
      consumeGithubOauthFlow(database.pool, stateHash),
      consumeGithubOauthFlow(database.pool, stateHash),
      consumeGithubOauthFlow(database.pool, stateHash),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.find((result) => result !== null)).toMatchObject({
      purpose: "maintainer_reauth",
      repositoryId,
      redirectPath: "/review",
    });
    await expect(
      database.pool.query(
        "UPDATE github_oauth_flows SET consumed_at = now() WHERE state_hash = $1",
        [stateHash],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.pool.query(
        "UPDATE github_oauth_flows SET redirect_path = '/review' WHERE state_hash = $1",
        [stateHash],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      database.pool.query(
        `UPDATE github_oauth_flows
            SET redirect_path = $2
          WHERE state_hash = $1`,
        [stateHash, `/revisions/${revisionId}/contribute`],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const columns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'github_oauth_flows'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain(
      "access_token",
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain(
      "user_token",
    );
  });

  it("rejects duplicate, expired, and non-allowlisted OAuth flows", async () => {
    const input = {
      stateHash: "c".repeat(64),
      purpose: "contributor_login" as const,
      repositoryId,
      redirectPath: `/revisions/${revisionId}/contribute/practice`,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    };
    await createGithubOauthFlow(database.pool, input);
    await expect(
      createGithubOauthFlow(database.pool, input),
    ).rejects.toBeInstanceOf(GithubOauthFlowConflictError);
    await expect(
      createGithubOauthFlow(database.pool, {
        ...input,
        stateHash: "d".repeat(64),
        redirectPath: "https://attacker.invalid/steal",
      }),
    ).rejects.toThrow();
    await expect(
      createGithubOauthFlow(database.pool, {
        ...input,
        stateHash: "e".repeat(64),
        expiresAt: new Date(Date.now() - 1_000),
      }),
    ).rejects.toBeInstanceOf(GithubOauthFlowConflictError);
  });

  it("stores unbound maintainer identify state and rejects mixed bindings", async () => {
    const stateHash = "f".repeat(64);
    await expect(
      createGithubOauthFlow(database.pool, {
        stateHash,
        purpose: "maintainer_identify",
        redirectPath: "/review",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      }),
    ).resolves.toMatchObject({
      purpose: "maintainer_identify",
      repositoryId: null,
      redirectPath: "/review",
    });
    await expect(
      consumeGithubOauthFlow(database.pool, stateHash),
    ).resolves.toMatchObject({
      purpose: "maintainer_identify",
      repositoryId: null,
    });
    await expect(
      database.pool.query(
        `INSERT INTO github_oauth_flows
           (state_hash, purpose, repository_id, redirect_path, expires_at)
         VALUES ($1, 'maintainer_identify', $2, '/review', now() + interval '5 minutes')`,
        ["1".repeat(64), repositoryId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.pool.query(
        `INSERT INTO github_oauth_flows
           (state_hash, purpose, repository_id, redirect_path, expires_at)
         VALUES ($1, 'maintainer_reauth', NULL, '/review', now() + interval '5 minutes')`,
        ["2".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("persists one immutable bounded revision source before transaction commit", async () => {
    const client = await database.pool.connect();
    const fetchedAt = new Date("2026-08-12T16:00:00.000Z");
    try {
      await client.query("BEGIN");
      const first = await persistGithubRevisionSourceInTransaction(client, {
        revisionId,
        fetchedAt,
        source: githubRevisionSource(),
      });
      const replay = await persistGithubRevisionSourceInTransaction(client, {
        revisionId,
        fetchedAt: new Date(fetchedAt.getTime() + 1_000),
        source: githubRevisionSource(),
      });
      expect(first.replay).toBe(false);
      expect(replay).toEqual({ sourceHash: first.sourceHash, replay: true });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const loaded = await loadGithubRevisionSource(database.pool, revisionId);
    expect(loaded).toMatchObject({
      revisionId,
      headSha,
      baseSha: "b".repeat(40),
      fetchedAt,
      source: { headSha, baseSha: "b".repeat(40), changedFiles: 1 },
    });
    await expect(
      database.pool.query(
        "UPDATE github_revision_sources SET fetched_at = now() WHERE revision_id = $1",
        [revisionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      database.pool.query(
        "DELETE FROM github_revision_sources WHERE revision_id = $1",
        [revisionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects conflicting or stale revision sources and rolls back with its business transaction", async () => {
    const oversizedClient = await database.pool.connect();
    try {
      await oversizedClient.query("BEGIN");
      await expect(
        persistGithubRevisionSourceInTransaction(oversizedClient, {
          revisionId,
          fetchedAt: new Date(),
          source: {
            ...githubRevisionSource(),
            files: [
              {
                ...githubRevisionSource().files[0]!,
                patch: "x".repeat(128 * 1_024 + 1),
              },
            ],
          },
        }),
      ).rejects.toThrow();
      await oversizedClient.query("ROLLBACK");
    } finally {
      oversizedClient.release();
    }

    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await persistGithubRevisionSourceInTransaction(client, {
        revisionId,
        fetchedAt: new Date(),
        source: githubRevisionSource(),
      });
      await client.query(
        "UPDATE pull_requests SET state = 'closed' WHERE id = $1",
        [pullRequestId],
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      await loadGithubRevisionSource(database.pool, revisionId),
    ).toBeNull();
    expect(
      await database.pool.query<{ state: string }>(
        "SELECT state FROM pull_requests WHERE id = $1",
        [pullRequestId],
      ),
    ).toMatchObject({ rows: [{ state: "open" }] });

    const sourceClient = await database.pool.connect();
    try {
      await sourceClient.query("BEGIN");
      await persistGithubRevisionSourceInTransaction(sourceClient, {
        revisionId,
        fetchedAt: new Date(),
        source: githubRevisionSource(),
      });
      await sourceClient.query("COMMIT");
    } finally {
      sourceClient.release();
    }
    const mutableReplayClient = await database.pool.connect();
    try {
      await mutableReplayClient.query("BEGIN");
      const replay = await persistGithubRevisionSourceInTransaction(
        mutableReplayClient,
        {
          revisionId,
          fetchedAt: new Date(),
          source: {
            ...githubRevisionSource(),
            state: "closed",
            draft: true,
            title: "Changed snapshot title",
            body: "Changed snapshot body",
            authorLogin: "renamed-contributor",
          },
        },
      );
      expect(replay.replay).toBe(true);
      await mutableReplayClient.query("ROLLBACK");
    } finally {
      mutableReplayClient.release();
    }

    const conflictingClient = await database.pool.connect();
    try {
      await conflictingClient.query("BEGIN");
      await expect(
        persistGithubRevisionSourceInTransaction(conflictingClient, {
          revisionId,
          fetchedAt: new Date(),
          source: {
            ...githubRevisionSource(),
            files: [
              {
                ...githubRevisionSource().files[0]!,
                patch: "@@ -1 +1 @@\n-old\n+different",
              },
            ],
          },
        }),
      ).rejects.toBeInstanceOf(GithubRevisionSourceConflictError);
      await conflictingClient.query("ROLLBACK");
    } finally {
      conflictingClient.release();
    }

    const kindConflictClient = await database.pool.connect();
    try {
      await kindConflictClient.query("BEGIN");
      await expect(
        persistGithubRevisionSourceInTransaction(kindConflictClient, {
          revisionId,
          fetchedAt: new Date(),
          source: {
            ...githubRevisionSource(),
            files: [
              {
                ...githubRevisionSource().files[0]!,
                gitKind: "symlink",
              },
            ],
          },
        }),
      ).rejects.toBeInstanceOf(GithubRevisionSourceConflictError);
      await kindConflictClient.query("ROLLBACK");
    } finally {
      kindConflictClient.release();
    }

    await database.pool.query(
      "UPDATE pull_request_revisions SET is_current = false WHERE id = $1",
      [revisionId],
    );
    const staleClient = await database.pool.connect();
    try {
      await staleClient.query("BEGIN");
      await expect(
        persistGithubRevisionSourceInTransaction(staleClient, {
          revisionId,
          fetchedAt: new Date(),
          source: githubRevisionSource(),
        }),
      ).rejects.toBeInstanceOf(StaleGithubRevisionSourceError);
      await staleClient.query("ROLLBACK");
    } finally {
      staleClient.release();
    }
  });

  it("persists one idempotent check intent and queue outbox effect", async () => {
    const input = checkIntent();
    const [first, replay] = await Promise.all([
      persistGithubCheckIntent(database.pool, outbox, input),
      persistGithubCheckIntent(database.pool, outbox, input),
    ]);
    expect([first.replay, replay.replay].sort()).toEqual([false, true]);
    expect(first.checkRunId).toBe(replay.checkRunId);

    const persisted = await database.pool.query<{
      github_check_run_id: string | null;
      sync_status: string;
      sync_attempts: number;
      intent_idempotency_key: string;
    }>(
      `SELECT github_check_run_id, sync_status, sync_attempts,
              intent_idempotency_key
         FROM check_runs WHERE revision_id = $1`,
      [revisionId],
    );
    expect(persisted.rows[0]).toMatchObject({
      github_check_run_id: null,
      sync_status: "pending",
      sync_attempts: 0,
      intent_idempotency_key: input.idempotencyKey,
    });
    const synchronization = await database.pool.query<{
      last_synchronized_at: Date | null;
    }>("SELECT last_synchronized_at FROM check_runs WHERE revision_id = $1", [
      revisionId,
    ]);
    expect(synchronization.rows[0]?.last_synchronized_at).toBeNull();
    expect(await jobCount(database, "github.reconcile-check", revisionId)).toBe(
      1,
    );
  });

  it("accepts local Fake details URLs but rejects non-loopback HTTP", async () => {
    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...checkIntent(),
        detailsUrl: `http://127.0.0.1:3000/revisions/${revisionId}`,
      }),
    ).resolves.toMatchObject({ replay: false });

    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...checkIntent(),
        idempotencyKey: "check:intent:insecure-http",
        detailsUrl: `http://slopproof.test/revisions/${revisionId}`,
      }),
    ).rejects.toThrow();
    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...checkIntent(),
        idempotencyKey: "check:intent:loopback-query",
        detailsUrl: `http://localhost:3000/revisions/${revisionId}?token=forbidden`,
      }),
    ).rejects.toThrow();
  });

  it("clears an old fake synchronization timestamp for a new remote intent", async () => {
    await database.pool.query(
      `INSERT INTO check_runs
         (revision_id, github_check_run_id, name, status, conclusion,
          public_summary, details_url, last_synchronized_at)
       VALUES ($1, 'fake-check:old', 'Old check', 'in_progress', NULL,
               'old fake state', $2, now())`,
      [revisionId, `https://slopproof.test/revisions/${revisionId}`],
    );
    await persistGithubCheckIntent(database.pool, outbox, checkIntent());

    const row = await database.pool.query<{
      sync_status: string;
      last_synchronized_at: Date | null;
    }>(
      `SELECT sync_status, last_synchronized_at
         FROM check_runs WHERE revision_id = $1`,
      [revisionId],
    );
    expect(row.rows[0]).toMatchObject({
      sync_status: "pending",
      last_synchronized_at: null,
    });
  });

  it("rolls back the intent when the transactional outbox fails", async () => {
    const failingOutbox: GithubCheckOutbox = {
      async publish() {
        throw new Error("simulated queue outage");
      },
    };
    await expect(
      persistGithubCheckIntent(database.pool, failingOutbox, checkIntent()),
    ).rejects.toThrow("simulated queue outage");
    expect(await count(database, "check_runs")).toBe(0);
  });

  it("joins the caller's business transaction and rolls back as one unit", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE pull_requests SET state = 'closed' WHERE id = $1",
        [pullRequestId],
      );
      await persistGithubCheckIntentInTransaction(
        client,
        outbox,
        checkIntent(),
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const pullRequest = await database.pool.query<{ state: string }>(
      "SELECT state FROM pull_requests WHERE id = $1",
      [pullRequestId],
    );
    expect(pullRequest.rows[0]?.state).toBe("open");
    expect(await count(database, "check_runs")).toBe(0);
    expect(await jobCount(database, "github.reconcile-check", revisionId)).toBe(
      0,
    );
  });

  it("rejects stale and conflicting check intents without overwriting state", async () => {
    const input = checkIntent();
    await persistGithubCheckIntent(database.pool, outbox, input);
    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...input,
        publicSummary: "different public payload",
      }),
    ).rejects.toBeInstanceOf(GithubCheckIntentConflictError);
    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...input,
        idempotencyKey: "check:intent:stale",
        expectedHeadSha: "f".repeat(40),
      }),
    ).rejects.toBeInstanceOf(StaleGithubCheckIntentError);

    const summary = await database.pool.query<{ public_summary: string }>(
      "SELECT public_summary FROM check_runs WHERE revision_id = $1",
      [revisionId],
    );
    expect(summary.rows[0]?.public_summary).toBe(input.publicSummary);
  });

  it("permits only a persisted cancelled invalidation for a non-current exact SHA", async () => {
    await database.pool.query(
      "UPDATE pull_request_revisions SET is_current = false WHERE id = $1",
      [revisionId],
    );
    const invalidation: GithubCheckIntent = {
      ...checkIntent(),
      idempotencyKey: "check:intent:revision-invalidated",
      reason: "revision_invalidated",
      status: "completed",
      conclusion: "cancelled",
      publicSummary: "This revision is no longer current.",
    };
    const persisted = await persistGithubCheckIntent(
      database.pool,
      outbox,
      invalidation,
    );

    await expect(
      claimGithubCheckSync(database.pool, {
        revisionId,
        expectedHeadSha: headSha,
        reason: "manual_reconcile",
      }),
    ).resolves.toBeNull();
    const claimed = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "revision_invalidated",
    });
    expect(claimed).toMatchObject({
      checkRunId: persisted.checkRunId,
      status: "completed",
      conclusion: "cancelled",
      intentReason: "revision_invalidated",
    });
    expect(
      await failGithubCheckSync(database.pool, {
        checkRunId: persisted.checkRunId,
        attempt: claimed!.attempt,
        errorClass: "StaleHead",
        retryable: false,
      }),
    ).toBe(true);

    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...invalidation,
        idempotencyKey: "check:intent:wrong-sha-invalidation",
        expectedHeadSha: "f".repeat(40),
      }),
    ).rejects.toBeInstanceOf(StaleGithubCheckIntentError);
    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...invalidation,
        idempotencyKey: "check:intent:non-cancelled-invalidation",
        status: "in_progress",
        conclusion: null,
      }),
    ).rejects.toBeInstanceOf(StaleGithubCheckIntentError);
  });

  it("enforces check status and conclusion consistency at every boundary", async () => {
    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...checkIntent(),
        status: "completed",
        conclusion: null,
      }),
    ).rejects.toThrow("completed checks require a conclusion");
    await expect(
      database.pool.query(
        `INSERT INTO check_runs
           (revision_id, name, status, conclusion, public_summary, details_url)
         VALUES ($1, 'Invalid', 'in_progress', 'success', 'invalid', $2)`,
        [revisionId, `https://slopproof.test/revisions/${revisionId}`],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("tracks compare-and-set sync attempts and a nullable remote check ID", async () => {
    const persisted = await persistGithubCheckIntent(
      database.pool,
      outbox,
      checkIntent(),
    );
    const first = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "webhook_ingested",
    });
    expect(first).toMatchObject({
      checkRunId: persisted.checkRunId,
      attempt: 1,
      githubCheckRunId: null,
    });
    expect(
      await failGithubCheckSync(database.pool, {
        checkRunId: persisted.checkRunId,
        attempt: 1,
        errorClass: "GithubRateLimitError",
        retryable: true,
        nextSyncAfter: new Date(Date.now() - 1_000),
      }),
    ).toBe(true);

    const second = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "webhook_ingested",
    });
    expect(second?.attempt).toBe(2);
    expect(
      await completeGithubCheckSync(database.pool, {
        checkRunId: persisted.checkRunId,
        attempt: 1,
        githubCheckRunId: "987654321",
      }),
    ).toBe(false);
    expect(
      await completeGithubCheckSync(database.pool, {
        checkRunId: persisted.checkRunId,
        attempt: 2,
        githubCheckRunId: "987654321",
      }),
    ).toBe(true);

    const row = await database.pool.query<{
      sync_status: string;
      sync_attempts: number;
      github_check_run_id: string;
      last_sync_error_class: string | null;
    }>(
      `SELECT sync_status, sync_attempts, github_check_run_id,
              last_sync_error_class
         FROM check_runs WHERE id = $1`,
      [persisted.checkRunId],
    );
    expect(row.rows[0]).toMatchObject({
      sync_status: "synchronized",
      sync_attempts: 2,
      github_check_run_id: "987654321",
      last_sync_error_class: null,
    });
  });

  it("does not claim a rate-limited Check before its durable retry deadline", async () => {
    const persisted = await persistGithubCheckIntent(
      database.pool,
      outbox,
      checkIntent(),
    );
    const first = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "webhook_ingested",
    });
    const nextSyncAfter = new Date(Date.now() + 60_000);
    await expect(
      failGithubCheckSync(database.pool, {
        checkRunId: persisted.checkRunId,
        attempt: first!.attempt,
        errorClass: "RateLimited",
        retryable: true,
        nextSyncAfter,
      }),
    ).resolves.toBe(true);
    await expect(
      claimGithubCheckSync(database.pool, {
        revisionId,
        expectedHeadSha: headSha,
        reason: "webhook_ingested",
      }),
    ).resolves.toBeNull();
    const row = await database.pool.query<{
      sync_status: string;
      next_sync_after: Date;
    }>(
      `SELECT sync_status, next_sync_after
         FROM check_runs WHERE id = $1`,
      [persisted.checkRunId],
    );
    expect(row.rows[0]?.sync_status).toBe("retry_required");
    expect(row.rows[0]?.next_sync_after.toISOString()).toBe(
      nextSyncAfter.toISOString(),
    );
  });

  it("durably replays repeated retryable failures across queue attempts", async () => {
    const persisted = await persistGithubCheckIntent(
      database.pool,
      outbox,
      checkIntent(),
    );
    const first = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "webhook_ingested",
    });
    await failGithubCheckSync(database.pool, {
      checkRunId: persisted.checkRunId,
      attempt: first!.attempt,
      errorClass: "Unavailable",
      retryable: true,
      nextSyncAfter: new Date(Date.now() - 1_000),
    });
    await database.pool.query(
      "DELETE FROM pgboss.job WHERE name = 'github.reconcile-check'",
    );
    await expect(
      replayDueGithubCheckSyncs(database.pool, outbox),
    ).resolves.toEqual({ examined: 1, published: 1 });
    const second = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "webhook_ingested",
    });
    expect(second?.attempt).toBe(2);

    await failGithubCheckSync(database.pool, {
      checkRunId: persisted.checkRunId,
      attempt: second!.attempt,
      errorClass: "Timeout",
      retryable: true,
      nextSyncAfter: new Date(Date.now() - 1_000),
    });
    await database.pool.query(
      "DELETE FROM pgboss.job WHERE name = 'github.reconcile-check'",
    );
    await expect(
      replayDueGithubCheckSyncs(database.pool, outbox),
    ).resolves.toEqual({ examined: 1, published: 1 });
    const third = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "webhook_ingested",
    });
    expect(third?.attempt).toBe(3);
  });

  it("does not regress a progressed same-tuple Check, but pass and close remain authoritative", async () => {
    const checks = new PostgresGithubCheckIntentWriter(
      outbox,
      "https://slopproof.test",
      false,
    );
    await persistGithubCheckIntent(database.pool, outbox, {
      ...checkIntent(),
      idempotencyKey: "check:intent:review-required",
      reason: "review_required",
      publicSummary: "maintainer review required",
    });

    const revisionPublisher = {
      publish: vi.fn(async () => "analysis-job"),
    };
    await processVerifiedPullRequestSnapshot(
      database.pool,
      checks,
      verifiedPullRequestOperation("ready_for_review"),
      revisionPublisher,
    );
    await expect(checkRow(database)).resolves.toMatchObject({
      intent_reason: "review_required",
      status: "in_progress",
      public_summary: "maintainer review required",
    });
    expect(revisionPublisher.publish).not.toHaveBeenCalled();
    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...checkIntent(),
        idempotencyKey: "check:intent:stale-analysis-review",
        reason: "analysis_ready",
        publicSummary: "stale proof ready",
      }),
    ).resolves.toMatchObject({ replay: true, queueJobId: null });
    await expect(checkRow(database)).resolves.toMatchObject({
      intent_reason: "review_required",
      public_summary: "maintainer review required",
    });

    const policyId = "81000000-0000-4000-8000-000000000010";
    const planId = "81000000-0000-4000-8000-000000000011";
    await database.pool.query(
      `INSERT INTO repository_policies
         (id, repository_id, version, schema_version, policy, policy_hash,
          created_by, activated_at)
       VALUES ($1, $2, 1, '1', '{"decisionMode":"maintainer_review"}',
               $3, 'test', now())`,
      [policyId, repositoryId, "e".repeat(64)],
    );
    await database.pool.query(
      `INSERT INTO proof_plans
         (id, revision_id, repository_policy_id, plan_version,
          deterministic_seed, risk_explanation, question_budget, plan_hash,
          status)
       VALUES ($1, $2, $3, 'planner-v1', 'seed', '{}', 1, $4, 'ready')`,
      [planId, revisionId, policyId, "f".repeat(64)],
    );
    await database.pool.query(
      `INSERT INTO attempts
         (repository_id, revision_id, author_id, proof_plan_id, head_sha,
          status, nonce_hash, expires_at, completed_at)
       VALUES ($1, $2, '8105', $3, $4, 'passed', $5,
               now() + interval '1 hour', now())`,
      [repositoryId, revisionId, planId, headSha, "1".repeat(64)],
    );
    await processVerifiedPullRequestSnapshot(
      database.pool,
      checks,
      verifiedPullRequestOperation("synchronize"),
    );
    await expect(checkRow(database)).resolves.toMatchObject({
      intent_reason: "webhook_ingested",
      status: "completed",
      conclusion: "success",
    });
    await expect(
      persistGithubCheckIntent(database.pool, outbox, {
        ...checkIntent(),
        idempotencyKey: "check:intent:stale-analysis-passed",
        reason: "analysis_ready",
        publicSummary: "stale proof ready after pass",
      }),
    ).resolves.toMatchObject({ replay: true, queueJobId: null });
    await expect(checkRow(database)).resolves.toMatchObject({
      intent_reason: "webhook_ingested",
      status: "completed",
      conclusion: "success",
    });

    await processVerifiedPullRequestSnapshot(database.pool, checks, {
      ...verifiedPullRequestOperation("closed"),
      pullRequest: {
        ...verifiedPullRequestOperation("closed").pullRequest,
        state: "closed",
      },
    });
    await expect(checkRow(database)).resolves.toMatchObject({
      intent_reason: "webhook_ingested",
      status: "completed",
      conclusion: "cancelled",
    });
  });

  it("reactivates a prior exact tuple from cancelled back to in-progress", async () => {
    const checks = new PostgresGithubCheckIntentWriter(
      outbox,
      "https://slopproof.test",
      false,
    );
    await processVerifiedPullRequestSnapshot(
      database.pool,
      checks,
      verifiedPullRequestOperation("ready_for_review"),
    );
    const movedBase = "d".repeat(40);
    await processVerifiedPullRequestSnapshot(database.pool, checks, {
      ...verifiedPullRequestOperation("synchronize"),
      idempotencyKey: "github:verified:base-b2",
      pullRequest: {
        ...verifiedPullRequestOperation("synchronize").pullRequest,
        baseSha: movedBase,
      },
    });
    await expect(checkRow(database)).resolves.toMatchObject({
      intent_reason: "revision_invalidated",
      status: "completed",
      conclusion: "cancelled",
    });

    await processVerifiedPullRequestSnapshot(
      database.pool,
      checks,
      verifiedPullRequestOperation("synchronize"),
    );
    await expect(checkRow(database)).resolves.toMatchObject({
      intent_reason: "webhook_ingested",
      status: "in_progress",
      conclusion: null,
    });
    const current = await database.pool.query<{
      id: string;
      base_sha: string;
    }>(
      `SELECT id, base_sha FROM pull_request_revisions
        WHERE pull_request_id = $1 AND is_current = true`,
      [pullRequestId],
    );
    expect(current.rows[0]).toEqual({
      id: revisionId,
      base_sha: "b".repeat(40),
    });
  });

  it("reprepares an exact tuple after close invalidated its only usable attempt", async () => {
    const checks = new PostgresGithubCheckIntentWriter(
      outbox,
      "https://slopproof.test",
      false,
    );
    const policyId = "81000000-0000-4000-8000-000000000020";
    const planId = "81000000-0000-4000-8000-000000000021";
    await database.pool.query(
      `INSERT INTO repository_policies
         (id, repository_id, version, schema_version, policy, policy_hash,
          created_by, activated_at)
       VALUES ($1, $2, 1, '1', '{}', $3, 'test', now())`,
      [policyId, repositoryId, "2".repeat(64)],
    );
    await database.pool.query(
      `INSERT INTO analysis_snapshots
         (revision_id, analyzer_version, diff_hash, snapshot, status)
       VALUES ($1, 'analyzer-v1', $2, '{}', 'ready')`,
      [revisionId, "3".repeat(64)],
    );
    await database.pool.query(
      `INSERT INTO proof_plans
         (id, revision_id, repository_policy_id, plan_version,
          deterministic_seed, risk_explanation, question_budget, plan_hash,
          status)
       VALUES ($1, $2, $3, 'planner-v1', 'seed', '{}', 1, $4, 'ready')`,
      [planId, revisionId, policyId, "4".repeat(64)],
    );
    await database.pool.query(
      `INSERT INTO attempts
         (repository_id, revision_id, author_id, proof_plan_id, head_sha,
          status, nonce_hash, expires_at)
       VALUES ($1, $2, '8105', $3, $4, 'ready', $5,
               now() + interval '1 hour')`,
      [repositoryId, revisionId, planId, headSha, "5".repeat(64)],
    );
    await processVerifiedPullRequestSnapshot(database.pool, checks, {
      ...verifiedPullRequestOperation("closed"),
      pullRequest: {
        ...verifiedPullRequestOperation("closed").pullRequest,
        state: "closed",
      },
    });
    const publisher = { publish: vi.fn(async () => "analysis-reprepare") };
    await processVerifiedPullRequestSnapshot(
      database.pool,
      checks,
      verifiedPullRequestOperation("synchronize"),
      publisher,
    );
    expect(publisher.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ revisionId, expectedHeadSha: headSha }),
    );
    const attempt = await database.pool.query<{ status: string }>(
      "SELECT status FROM attempts WHERE revision_id = $1",
      [revisionId],
    );
    expect(attempt.rows[0]?.status).toBe("invalidated");
  });

  it("terminally parks inactive Checks with a lifecycle CAS and replays the unchanged advanced intent after fresh reactivation", async () => {
    const checks = new PostgresGithubCheckIntentWriter(
      outbox,
      "https://slopproof.test",
      true,
    );
    const persisted = await persistGithubCheckIntent(database.pool, outbox, {
      ...checkIntent(),
      idempotencyKey: "check:intent:inactive-review",
      reason: "review_required",
      publicSummary: "maintainer review required",
    });
    const claimed = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "review_required",
    });
    await database.pool.query(
      `UPDATE repositories
          SET status = 'suspended', suspended_at = now(), removed_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [repositoryId],
    );
    await expect(
      completeInactiveGithubCheckSync(database.pool, {
        checkRunId: persisted.checkRunId,
        attempt: claimed!.attempt,
      }),
    ).resolves.toBe(true);
    await expect(
      replayDueGithubCheckSyncs(database.pool, outbox),
    ).resolves.toEqual({ examined: 0, published: 0 });

    const fence = await lifecycleFence(database);
    await processVerifiedPullRequestSnapshot(
      database.pool,
      checks,
      verifiedPullRequestOperation("synchronize"),
      undefined,
      {
        source: githubRevisionSource(),
        fetchedAt: new Date(),
        authorizationFence: {
          freshAuthorization: true,
          ...fence,
        },
      },
    );
    await expect(checkRow(database)).resolves.toMatchObject({
      intent_reason: "review_required",
      public_summary: "maintainer review required",
    });
    await expect(
      claimGithubCheckSync(database.pool, {
        revisionId,
        expectedHeadSha: headSha,
        reason: "review_required",
      }),
    ).resolves.toMatchObject({ checkRunId: persisted.checkRunId });

    await database.pool.query(
      `UPDATE repositories
          SET status = 'active', suspended_at = NULL, removed_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [repositoryId],
    );
    await expect(
      completeInactiveGithubCheckSync(database.pool, {
        checkRunId: persisted.checkRunId,
        attempt: claimed!.attempt,
      }),
    ).resolves.toBe(false);
  });

  it("reclaims only an expired syncing lease after a worker crash", async () => {
    await persistGithubCheckIntent(database.pool, outbox, checkIntent());
    const first = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "webhook_ingested",
    });
    expect(first?.attempt).toBe(1);
    await expect(
      claimGithubCheckSync(database.pool, {
        revisionId,
        expectedHeadSha: headSha,
        reason: "webhook_ingested",
      }),
    ).resolves.toBeNull();

    await database.pool.query(
      `UPDATE check_runs
          SET updated_at = now() - interval '3 minutes'
        WHERE revision_id = $1`,
      [revisionId],
    );
    const reclaimed = await claimGithubCheckSync(database.pool, {
      revisionId,
      expectedHeadSha: headSha,
      reason: "webhook_ingested",
    });
    expect(reclaimed).toMatchObject({
      checkRunId: first?.checkRunId,
      attempt: 2,
    });
  });

  it("replays a persisted PR delivery without redelivery, preserves future delay, and heals a failed FIFO singleton", async () => {
    const deliveryId = "81000000-0000-4000-8000-000000000099";
    const payloadHash = "9".repeat(64);
    const payload = {
      ...verifiedPullRequestOperation("synchronize"),
      deliveryId,
      eventName: "pull_request" as const,
    };
    await database.pool.query(
      `INSERT INTO webhook_deliveries
         (delivery_id, event_name, payload_hash, processing_status,
          queued_at, job_payload)
       VALUES ($1, 'pull_request', $2, 'queued',
               now() - interval '3 minutes', $3::jsonb)`,
      [deliveryId, payloadHash, JSON.stringify(payload)],
    );
    const dependencies = {
      database,
      queue,
      appBaseUrl: "https://slopproof.test",
      adapter: "fake",
    } satisfies GithubControlDependencies;

    await expect(
      sweepDueGithubPullRequestDeliveries(dependencies),
    ).resolves.toEqual({ examined: 1, published: 1 });
    const first = await database.pool.query<{ id: string }>(
      `SELECT id FROM pgboss.job
        WHERE name = 'github.ingest-pr' AND singleton_key = '8103:184'`,
    );
    expect(first.rows).toHaveLength(1);

    await database.pool.query(
      `UPDATE webhook_deliveries
          SET next_retry_at = now() + interval '10 minutes'
        WHERE delivery_id = $1`,
      [deliveryId],
    );
    await expect(
      reserveWebhookDelivery(database.pool, {
        deliveryId,
        eventName: "pull_request",
        payloadHash,
      }),
    ).resolves.toEqual({ duplicate: true, shouldEnqueue: false });
    const deferred = await database.pool.query<{ remaining: boolean }>(
      `SELECT next_retry_at > now() AS remaining
         FROM webhook_deliveries WHERE delivery_id = $1`,
      [deliveryId],
    );
    expect(deferred.rows[0]?.remaining).toBe(true);

    await database.pool.query(
      `UPDATE pgboss.job
          SET state = 'failed', completed_on = now(), retry_count = retry_limit
        WHERE id = $1`,
      [first.rows[0]!.id],
    );
    await database.pool.query(
      `UPDATE webhook_deliveries
          SET next_retry_at = now() - interval '1 second'
        WHERE delivery_id = $1`,
      [deliveryId],
    );
    await expect(
      sweepDueGithubPullRequestDeliveries(dependencies),
    ).resolves.toEqual({ examined: 1, published: 1 });
    const healed = await database.pool.query<{
      id: string;
      state: string;
    }>("SELECT id, state FROM pgboss.job WHERE id = $1", [first.rows[0]!.id]);
    expect(healed.rows[0]).toMatchObject({
      id: first.rows[0]!.id,
      state: "retry",
    });
  });

  it("keeps the first pending recovery candidate immutable when a late old-installation added event arrives", async () => {
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000001",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000002",
      action: "added",
      installationId: "8101",
      accountId: "8102",
      accountLogin: "acme",
    });

    await expect(recoveryState(database)).resolves.toMatchObject({
      recoveryBinding: recoveryBinding(),
      refreshDue: true,
      currentInstallationId: "8101",
    });
  });

  it.each([
    ["suspend", "83000000-0000-4000-8000-000000000003"],
    ["remove", "83000000-0000-4000-8000-000000000004"],
  ] as const)(
    "does not let a delayed old-installation %s event erase another installation's recovery candidate or due refresh",
    async (action, deliveryId) => {
      await ingestRepositoryLifecycle(database, {
        deliveryId: "83000000-0000-4000-8000-000000000005",
        action: "added",
        installationId: recoveryInstallationId,
        accountId: recoveryAccountId,
        accountLogin: recoveryAccountLogin,
      });

      if (action === "suspend") {
        await ingestInstallationLifecycle(database, {
          deliveryId,
          action,
          installationId: "8101",
          accountId: "8102",
          accountLogin: "acme",
        });
      } else {
        await ingestRepositoryLifecycle(database, {
          deliveryId,
          action: "removed",
          installationId: "8101",
          accountId: "8102",
          accountLogin: "acme",
        });
      }

      await expect(recoveryState(database)).resolves.toMatchObject({
        recoveryBinding: recoveryBinding(),
        refreshDue: true,
        currentInstallationId: "8101",
      });
    },
  );

  it("loads a pending recovery through the candidate installation while fencing the old repository binding", async () => {
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000006",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    const pullRequests = recoveryPullRequestPort();

    await handleGithubRefreshPullRequestJob(
      recoveryRefreshJob(recoveryInstallationId, "candidate-loader"),
      recoveryControlDependencies(database, queue, pullRequests),
    );

    expect(pullRequests.getCurrentHeadFresh).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: recoveryInstallationId,
        repositoryId: "8103",
        owner: "acme",
        repositoryName: "cachekit",
        pullNumber: 184,
      }),
    );
    expect(pullRequests.loadFresh).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: recoveryInstallationId,
        repositoryId: "8103",
        owner: "acme",
        repositoryName: "cachekit",
        pullNumber: 184,
        expectedHeadSha: headSha,
        expectedBaseSha: "b".repeat(40),
      }),
    );
    expect(pullRequests.getCurrentHead).not.toHaveBeenCalled();
    expect(pullRequests.load).not.toHaveBeenCalled();
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: recoveryInstallationId,
      recoveryBinding: null,
    });
  });

  it("rejects a recovery CAS when the old repository fence changes during the candidate GitHub read", async () => {
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000008",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    const pullRequests = recoveryPullRequestPort();
    pullRequests.getCurrentHeadFresh.mockImplementationOnce(async () => {
      await database.pool.query(
        `UPDATE repositories
            SET owner = 'raced-owner', updated_at = clock_timestamp()
          WHERE id = $1`,
        [repositoryId],
      );
      return {
        headSha,
        baseSha: "b".repeat(40),
        state: "open",
      };
    });

    await handleGithubRefreshPullRequestJob(
      recoveryRefreshJob(recoveryInstallationId, "old-repository-fence"),
      recoveryControlDependencies(database, queue, pullRequests),
    );

    expect(pullRequests.getCurrentHeadFresh).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: recoveryInstallationId }),
    );
    expect(pullRequests.loadFresh).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: recoveryInstallationId }),
    );
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      refreshDue: true,
    });
  });

  it("clears only the exact winning recovery candidate and prevents an old worker from rebinding it", async () => {
    const oldHead = deferred<{
      headSha: string;
      baseSha: string;
      state: "open";
    }>();
    const oldPullRequests = recoveryPullRequestPort();
    oldPullRequests.getCurrentHead.mockImplementationOnce(
      () => oldHead.promise,
    );
    const oldWorker = handleGithubRefreshPullRequestJob(
      recoveryRefreshJob("8101", "old-worker"),
      recoveryControlDependencies(database, queue, oldPullRequests),
    );
    await vi.waitFor(() => {
      expect(oldPullRequests.getCurrentHead).toHaveBeenCalledOnce();
    });

    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000007",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    const winningPullRequests = recoveryPullRequestPort();
    await handleGithubRefreshPullRequestJob(
      recoveryRefreshJob(recoveryInstallationId, "winning-worker"),
      recoveryControlDependencies(database, queue, winningPullRequests),
    );
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: recoveryInstallationId,
      recoveryBinding: null,
    });

    oldHead.resolve({
      headSha,
      baseSha: "b".repeat(40),
      state: "open",
    });
    await expect(oldWorker).resolves.toBeUndefined();

    expect(oldPullRequests.load).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "8101" }),
    );
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: recoveryInstallationId,
      recoveryBinding: null,
    });
  });

  it.each([
    ["installation.deleted", "installation"],
    ["installation_repositories.removed", "repository"],
  ] as const)(
    "clears an exact recovery candidate and parks its refresh after %s",
    async (_eventName, eventKind) => {
      await ingestRepositoryLifecycle(database, {
        deliveryId: "83000000-0000-4000-8000-000000000009",
        action: "added",
        installationId: recoveryInstallationId,
        accountId: recoveryAccountId,
        accountLogin: recoveryAccountLogin,
      });

      if (eventKind === "installation") {
        await ingestInstallationLifecycle(database, {
          deliveryId: "83000000-0000-4000-8000-000000000010",
          action: "deleted",
          installationId: recoveryInstallationId,
          accountId: recoveryAccountId,
          accountLogin: recoveryAccountLogin,
        });
      } else {
        await ingestRepositoryLifecycle(database, {
          deliveryId: "83000000-0000-4000-8000-000000000011",
          action: "removed",
          installationId: recoveryInstallationId,
          accountId: recoveryAccountId,
          accountLogin: recoveryAccountLogin,
        });
      }

      await expect(recoveryState(database)).resolves.toMatchObject({
        currentInstallationId: "8101",
        recoveryBinding: null,
        refreshDue: false,
        candidateInstallationIds: [],
      });
    },
  );

  it("promotes a queued I3 recovery candidate when installation.deleted removes the active I2 candidate", async () => {
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000012",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000013",
      action: "added",
      installationId: fallbackRecoveryInstallationId,
      accountId: fallbackRecoveryAccountId,
      accountLogin: fallbackRecoveryAccountLogin,
    });

    await ingestInstallationLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000014",
      action: "deleted",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });

    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: fallbackRecoveryBinding(),
      refreshDue: true,
      candidateInstallationIds: [fallbackRecoveryInstallationId],
    });
  });

  it.each([
    [403, "promotes the queued fallback", true],
    [404, "parks the refresh without a fallback", false],
  ] as const)(
    "discards an exact recovery candidate after permanent fresh HTTP %s and then %s",
    async (status, _expectedOutcome, hasFallback) => {
      await ingestRepositoryLifecycle(database, {
        deliveryId: "83000000-0000-4000-8000-000000000015",
        action: "added",
        installationId: recoveryInstallationId,
        accountId: recoveryAccountId,
        accountLogin: recoveryAccountLogin,
      });
      if (hasFallback) {
        await ingestRepositoryLifecycle(database, {
          deliveryId: "83000000-0000-4000-8000-000000000016",
          action: "added",
          installationId: fallbackRecoveryInstallationId,
          accountId: fallbackRecoveryAccountId,
          accountLogin: fallbackRecoveryAccountLogin,
        });
      }
      const pullRequests = recoveryPullRequestPort();
      pullRequests.getCurrentHeadFresh.mockRejectedValueOnce(
        new GithubControlError("REJECTED", { status }),
      );

      await handleGithubRefreshPullRequestJob(
        recoveryRefreshJob(
          recoveryInstallationId,
          `permanent-${String(status)}`,
        ),
        recoveryControlDependencies(database, queue, pullRequests),
      );

      expect(pullRequests.loadFresh).not.toHaveBeenCalled();
      await expect(recoveryState(database)).resolves.toMatchObject(
        hasFallback
          ? {
              currentInstallationId: "8101",
              recoveryBinding: fallbackRecoveryBinding(),
              refreshDue: true,
              candidateInstallationIds: [fallbackRecoveryInstallationId],
            }
          : {
              currentInstallationId: "8101",
              recoveryBinding: null,
              refreshDue: false,
              candidateInstallationIds: [],
            },
      );
    },
  );

  it("heals the same failed analysis strict-FIFO singleton when a closed exact revision reopens", async () => {
    await database.pool.query(
      `DELETE FROM pgboss.job
        WHERE name = 'analysis.prepare-revision' AND singleton_key = $1`,
      [revisionId],
    );
    const openPullRequests = recoveryPullRequestPort();
    const dependencies = recoveryControlDependencies(
      database,
      queue,
      openPullRequests,
    );
    await handleGithubRefreshPullRequestJob(
      recoveryRefreshJob("8101", "analysis-initial"),
      dependencies,
    );
    const initial = await database.pool.query<{
      id: string;
      state: string;
      data: unknown;
    }>(
      `SELECT id, state, data
         FROM pgboss.job
        WHERE name = 'analysis.prepare-revision' AND singleton_key = $1`,
      [revisionId],
    );
    expect(initial.rows).toHaveLength(1);
    const initialJobId = initial.rows[0]!.id;
    await database.pool.query(
      `UPDATE pgboss.job
          SET state = 'failed', completed_on = now(), retry_count = retry_limit
        WHERE id = $1`,
      [initialJobId],
    );

    const closedPullRequests = recoveryPullRequestPort("closed");
    await handleGithubRefreshPullRequestJob(
      recoveryRefreshJob("8101", "analysis-close"),
      recoveryControlDependencies(database, queue, closedPullRequests),
    );
    await handleGithubRefreshPullRequestJob(
      recoveryRefreshJob("8101", "analysis-reopen"),
      dependencies,
    );

    const healed = await database.pool.query<{
      id: string;
      state: string;
      data: Record<string, unknown>;
    }>(
      `SELECT id, state, data
         FROM pgboss.job
        WHERE name = 'analysis.prepare-revision' AND singleton_key = $1`,
      [revisionId],
    );
    expect(healed.rows).toHaveLength(1);
    expect(healed.rows[0]).toMatchObject({
      id: initialJobId,
      state: "retry",
      data: {
        schemaVersion: "1",
        idempotencyKey: `analysis:${revisionId}:${headSha}`,
        revisionId,
        expectedHeadSha: headSha,
      },
    });
  });

  it("keeps an already-queued cross-binding candidate parked across suspend and a stale 403, then reactivates it exactly after unsuspend", async () => {
    await database.pool.query(
      `DELETE FROM pgboss.job
        WHERE name = 'github.ingest-pr' AND singleton_key = '8103:184'`,
    );
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000017",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    const queueingDependencies = recoveryControlDependencies(
      database,
      queue,
      recoveryPullRequestPort(),
    );
    await expect(
      sweepDueGithubPullRequestRefreshes(queueingDependencies),
    ).resolves.toEqual({ examined: 1, published: 1 });
    const queued = await database.pool.query<{ data: unknown }>(
      `SELECT data FROM pgboss.job
        WHERE name = 'github.ingest-pr' AND singleton_key = '8103:184'`,
    );
    expect(queued.rows).toHaveLength(1);
    const queuedRefresh = GithubRefreshPrJobSchema.parse(queued.rows[0]!.data);
    expect(queuedRefresh).toMatchObject({
      eventName: "pull_request_refresh",
      installationId: recoveryInstallationId,
      repositoryId: "8103",
      pullNumber: 184,
      expectedHeadSha: headSha,
    });

    await ingestInstallationLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000018",
      action: "suspend",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      refreshDue: false,
      candidateInstallationIds: [recoveryInstallationId],
    });

    const staleFreshPort = recoveryPullRequestPort();
    staleFreshPort.getCurrentHeadFresh.mockRejectedValueOnce(
      new GithubControlError("REJECTED", { status: 403 }),
    );
    await handleGithubRefreshPullRequestJob(
      queuedRefresh,
      recoveryControlDependencies(database, queue, staleFreshPort),
    );
    expect(staleFreshPort.getCurrentHeadFresh).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: recoveryInstallationId }),
    );
    expect(staleFreshPort.loadFresh).not.toHaveBeenCalled();
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      refreshDue: false,
      candidateInstallationIds: [recoveryInstallationId],
    });

    await ingestInstallationLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000019",
      action: "unsuspend",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      refreshDue: true,
      candidateInstallationIds: [recoveryInstallationId],
    });

    const successfulFreshPort = recoveryPullRequestPort();
    await handleGithubRefreshPullRequestJob(
      queuedRefresh,
      recoveryControlDependencies(database, queue, successfulFreshPort),
    );
    expect(successfulFreshPort.getCurrentHeadFresh).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: recoveryInstallationId }),
    );
    expect(successfulFreshPort.loadFresh).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: recoveryInstallationId }),
    );
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: recoveryInstallationId,
      currentInstallationStatus: "active",
      repositoryStatus: "active",
      recoveryBinding: null,
      candidateInstallationIds: [],
    });
  });

  it("prevents a stale I2 fresh worker from rebinding after repository removal promotes I3", async () => {
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000020",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000021",
      action: "added",
      installationId: fallbackRecoveryInstallationId,
      accountId: fallbackRecoveryAccountId,
      accountLogin: fallbackRecoveryAccountLogin,
    });
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      candidateInstallationIds: [
        recoveryInstallationId,
        fallbackRecoveryInstallationId,
      ],
    });

    const freshSourceBarrier =
      deferred<ReturnType<typeof githubRevisionSource>>();
    const staleI2Port = recoveryPullRequestPort();
    staleI2Port.loadFresh.mockImplementationOnce(
      () => freshSourceBarrier.promise,
    );
    const staleI2Worker = handleGithubRefreshPullRequestJob(
      recoveryRefreshJob(recoveryInstallationId, "stale-winner-i2"),
      recoveryControlDependencies(database, queue, staleI2Port),
    );
    await vi.waitFor(() => {
      expect(staleI2Port.getCurrentHeadFresh).toHaveBeenCalledOnce();
      expect(staleI2Port.loadFresh).toHaveBeenCalledOnce();
    });

    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000022",
      action: "removed",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: fallbackRecoveryBinding(),
      refreshDue: true,
      candidateInstallationIds: [fallbackRecoveryInstallationId],
    });

    freshSourceBarrier.resolve(githubRevisionSource());
    await expect(staleI2Worker).resolves.toBeUndefined();

    expect(staleI2Port.loadFresh).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: recoveryInstallationId }),
    );
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      currentInstallationStatus: "active",
      repositoryStatus: "active",
      recoveryBinding: fallbackRecoveryBinding(),
      refreshDue: true,
      candidateInstallationIds: [fallbackRecoveryInstallationId],
    });
    await expect(
      database.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM github_revision_sources
          WHERE revision_id = $1`,
        [revisionId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("retains an exact candidate when suspend wins after an active fence but before a fresh 403", async () => {
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000023",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await expect(recoveryState(database)).resolves.toMatchObject({
      recoveryBinding: recoveryBinding(),
      refreshDue: true,
      recoveryTargetInstallationStatus: "active",
      candidateInstallationIds: [recoveryInstallationId],
    });

    const headBarrier = deferred<never>();
    const activeFencePort = recoveryPullRequestPort();
    activeFencePort.getCurrentHeadFresh.mockImplementationOnce(
      () => headBarrier.promise,
    );
    const activeFenceWorker = handleGithubRefreshPullRequestJob(
      recoveryRefreshJob(recoveryInstallationId, "active-fence-suspend-race"),
      recoveryControlDependencies(database, queue, activeFencePort),
    );
    await vi.waitFor(() => {
      expect(activeFencePort.getCurrentHeadFresh).toHaveBeenCalledOnce();
    });

    await ingestInstallationLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000024",
      action: "suspend",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      refreshDue: false,
      recoveryTargetInstallationStatus: "suspended",
      candidateInstallationIds: [recoveryInstallationId],
    });

    headBarrier.reject(new GithubControlError("REJECTED", { status: 403 }));
    await expect(activeFenceWorker).resolves.toBeUndefined();

    expect(activeFencePort.loadFresh).not.toHaveBeenCalled();
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      refreshDue: false,
      recoveryTargetInstallationStatus: "suspended",
      candidateInstallationIds: [recoveryInstallationId],
    });
  });

  it("preserves a later unsuspend wake-up when an older suspended-fence worker returns 403", async () => {
    await ingestRepositoryLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000025",
      action: "added",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await ingestInstallationLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000026",
      action: "suspend",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await expect(recoveryState(database)).resolves.toMatchObject({
      recoveryBinding: recoveryBinding(),
      refreshDue: false,
      recoveryTargetInstallationStatus: "suspended",
      candidateInstallationIds: [recoveryInstallationId],
    });

    const headBarrier = deferred<never>();
    const suspendedFencePort = recoveryPullRequestPort();
    suspendedFencePort.getCurrentHeadFresh.mockImplementationOnce(
      () => headBarrier.promise,
    );
    const suspendedFenceWorker = handleGithubRefreshPullRequestJob(
      recoveryRefreshJob(
        recoveryInstallationId,
        "suspended-fence-unsuspend-race",
      ),
      recoveryControlDependencies(database, queue, suspendedFencePort),
    );
    await vi.waitFor(() => {
      expect(suspendedFencePort.getCurrentHeadFresh).toHaveBeenCalledOnce();
    });

    await ingestInstallationLifecycle(database, {
      deliveryId: "83000000-0000-4000-8000-000000000027",
      action: "unsuspend",
      installationId: recoveryInstallationId,
      accountId: recoveryAccountId,
      accountLogin: recoveryAccountLogin,
    });
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      refreshDue: true,
      candidateInstallationIds: [recoveryInstallationId],
    });

    headBarrier.reject(new GithubControlError("REJECTED", { status: 403 }));
    await expect(suspendedFenceWorker).resolves.toBeUndefined();

    expect(suspendedFencePort.loadFresh).not.toHaveBeenCalled();
    await expect(recoveryState(database)).resolves.toMatchObject({
      currentInstallationId: "8101",
      recoveryBinding: recoveryBinding(),
      refreshDue: true,
      candidateInstallationIds: [recoveryInstallationId],
    });
  });
});

function recoveryBinding() {
  return {
    installationId: recoveryInstallationId,
    accountId: recoveryAccountId,
    accountLogin: recoveryAccountLogin,
    owner: "acme",
    repositoryName: "cachekit",
  };
}

function fallbackRecoveryBinding() {
  return {
    installationId: fallbackRecoveryInstallationId,
    accountId: fallbackRecoveryAccountId,
    accountLogin: fallbackRecoveryAccountLogin,
    owner: "acme",
    repositoryName: "cachekit",
  };
}

async function recoveryState(database: DatabaseConnection) {
  const result = await database.pool.query<{
    github_recovery_binding: unknown;
    refresh_due: boolean;
    current_installation_id: string;
    current_installation_status: string;
    repository_status: string;
    recovery_target_installation_status: string | null;
    candidate_installation_ids: string[];
  }>(
    `SELECT pull_request.github_recovery_binding,
            pull_request.next_github_refresh_at IS NOT NULL AS refresh_due,
            installation.github_installation_id AS current_installation_id,
            installation.status AS current_installation_status,
            repository.status AS repository_status,
            (
              SELECT target_installation.status::text
                FROM installations target_installation
               WHERE target_installation.github_installation_id =
                     pull_request.github_recovery_binding->>'installationId'
            ) AS recovery_target_installation_status,
            ARRAY(
              SELECT candidate.github_installation_id
                FROM github_recovery_candidates candidate
               WHERE candidate.pull_request_id = pull_request.id
               ORDER BY candidate.created_at, candidate.github_installation_id
            ) AS candidate_installation_ids
       FROM pull_requests pull_request
       JOIN repositories repository ON repository.id = pull_request.repository_id
       JOIN installations installation ON installation.id = repository.installation_id
      WHERE pull_request.id = $1`,
    [pullRequestId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Recovery test aggregate is missing");
  return {
    recoveryBinding: row.github_recovery_binding,
    refreshDue: row.refresh_due,
    currentInstallationId: row.current_installation_id,
    currentInstallationStatus: row.current_installation_status,
    repositoryStatus: row.repository_status,
    recoveryTargetInstallationStatus: row.recovery_target_installation_status,
    candidateInstallationIds: row.candidate_installation_ids,
  };
}

async function ingestRepositoryLifecycle(
  database: DatabaseConnection,
  input: {
    deliveryId: string;
    action: "added" | "removed";
    installationId: string;
    accountId: string;
    accountLogin: string;
  },
): Promise<void> {
  await database.pool.query(
    `INSERT INTO github_app_account_allowlist (github_account_id, status)
     VALUES ($1, 'active')
     ON CONFLICT (github_account_id) DO NOTHING`,
    [input.accountId],
  );
  const repository = {
    id: 8103,
    name: "cachekit",
    full_name: "acme/cachekit",
    default_branch: "main",
  };
  await ingestLifecycleWebhook(database, {
    deliveryId: input.deliveryId,
    eventName: "installation_repositories",
    payload: {
      action: input.action,
      installation: {
        id: Number(input.installationId),
        account: {
          id: Number(input.accountId),
          login: input.accountLogin,
        },
        repository_selection: "selected",
      },
      repositories_added: input.action === "added" ? [repository] : [],
      repositories_removed: input.action === "removed" ? [repository] : [],
    },
  });
}

async function ingestInstallationLifecycle(
  database: DatabaseConnection,
  input: {
    deliveryId: string;
    action: "suspend" | "unsuspend" | "deleted";
    installationId: string;
    accountId: string;
    accountLogin: string;
  },
): Promise<void> {
  await ingestLifecycleWebhook(database, {
    deliveryId: input.deliveryId,
    eventName: "installation",
    payload: {
      action: input.action,
      installation: {
        id: Number(input.installationId),
        account: {
          id: Number(input.accountId),
          login: input.accountLogin,
        },
        repository_selection: "selected",
      },
      repositories: [],
    },
  });
}

async function ingestLifecycleWebhook(
  database: DatabaseConnection,
  input: {
    deliveryId: string;
    eventName: "installation" | "installation_repositories";
    payload: unknown;
  },
): Promise<void> {
  const rawBody = new TextEncoder().encode(JSON.stringify(input.payload));
  const queueStub: PullRequestJobPublisher = {
    publish: vi.fn(async () => "unexpected-lifecycle-publish"),
    publishInTransaction: vi.fn(async () => null),
  };
  await ingestGithubWebhook({
    pool: database.pool,
    queue: queueStub,
    secret: webhookSecret,
    rawBody,
    headers: {
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      signature: `sha256=${createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex")}`,
    },
  });
  expect(queueStub.publish).not.toHaveBeenCalled();
  expect(queueStub.publishInTransaction).not.toHaveBeenCalled();
}

function recoveryPullRequestPort(state: "open" | "closed" = "open") {
  const source = { ...githubRevisionSource(), state };
  const current = {
    headSha: source.headSha,
    baseSha: source.baseSha,
    state: source.state,
  };
  return {
    load: vi.fn(async () => source),
    loadFresh: vi.fn(async () => source),
    getCurrentHead: vi.fn(async () => current),
    getCurrentHeadFresh: vi.fn(async () => current),
  } satisfies GithubPullRequestPort & GithubPullRequestHeadPort;
}

function recoveryRefreshJob(installationId: string, suffix: string) {
  return {
    schemaVersion: "1" as const,
    idempotencyKey: `github:recovery:${suffix}`,
    eventName: "pull_request_refresh" as const,
    installationId,
    repositoryId: "8103",
    owner: "acme",
    repositoryName: "cachekit",
    pullNumber: 184,
    expectedHeadSha: headSha,
  };
}

function recoveryControlDependencies(
  database: DatabaseConnection,
  queue: GithubControlDependencies["queue"],
  pullRequests: ReturnType<typeof recoveryPullRequestPort>,
): GithubControlDependencies {
  return {
    database,
    queue,
    appBaseUrl: "https://slopproof.test",
    adapter: "octokit",
    pullRequests,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function checkIntent(): GithubCheckIntent {
  return {
    revisionId,
    expectedHeadSha: headSha,
    idempotencyKey: "check:intent:revision-1",
    reason: "webhook_ingested",
    name: "UnderstandProof / understanding required",
    status: "in_progress",
    conclusion: null,
    publicSummary: "understanding required for the current head",
    detailsUrl: `https://slopproof.test/revisions/${revisionId}`,
  };
}

function verifiedPullRequestOperation(
  action: "ready_for_review" | "synchronize" | "closed",
) {
  return {
    schemaVersion: "1" as const,
    idempotencyKey: `github:verified:${action}`,
    action,
    installation: {
      githubInstallationId: "8101",
      accountId: "8102",
      accountLogin: "acme",
    },
    repository: {
      githubRepositoryId: "8103",
      owner: "acme",
      name: "cachekit",
      defaultBranch: "main",
    },
    pullRequest: {
      githubPullRequestId: "8104",
      number: 184,
      state: "open" as const,
      authorId: "8105",
      headSha,
      baseSha: "b".repeat(40),
    },
  };
}

async function checkRow(database: DatabaseConnection) {
  const result = await database.pool.query<{
    intent_reason: string | null;
    status: string;
    conclusion: string | null;
    public_summary: string;
  }>(
    `SELECT intent_reason, status, conclusion, public_summary
       FROM check_runs WHERE revision_id = $1`,
    [revisionId],
  );
  return result.rows[0];
}

async function lifecycleFence(database: DatabaseConnection) {
  const installation = await database.pool.query<{
    github_installation_id: string;
    status: "active" | "suspended" | "removed";
    version: string;
  }>(
    `SELECT github_installation_id, status, updated_at::text AS version
       FROM installations WHERE id = $1`,
    [installationId],
  );
  const repository = await database.pool.query<{
    github_repository_id: string;
    github_installation_id: string;
    status: "active" | "suspended" | "removed";
    owner: string;
    name: string;
    version: string;
  }>(
    `SELECT repository.github_repository_id,
            installation.github_installation_id,
            repository.status, repository.owner, repository.name,
            repository.updated_at::text AS version
       FROM repositories repository
       JOIN installations installation
         ON installation.id = repository.installation_id
      WHERE repository.id = $1`,
    [repositoryId],
  );
  return {
    installation: installation.rows[0]
      ? {
          githubInstallationId: installation.rows[0].github_installation_id,
          status: installation.rows[0].status,
          version: installation.rows[0].version,
        }
      : null,
    repository: repository.rows[0]
      ? {
          githubRepositoryId: repository.rows[0].github_repository_id,
          githubInstallationId: repository.rows[0].github_installation_id,
          status: repository.rows[0].status,
          owner: repository.rows[0].owner,
          name: repository.rows[0].name,
          version: repository.rows[0].version,
        }
      : null,
  };
}

function githubRevisionSource() {
  return {
    githubPullRequestId: "8104",
    number: 184,
    state: "open" as const,
    draft: false,
    title: "Harden the cache boundary",
    body: "Patch-bound source fixture",
    authorId: "8105",
    authorLogin: "contributor",
    headSha,
    baseSha: "b".repeat(40),
    changedFiles: 1,
    isFork: false,
    files: [
      {
        sha: "c".repeat(40),
        filename: "src/cache.ts",
        previousFilename: null,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-old\n+new",
        gitKind: "blob" as const,
      },
    ],
    limitsHit: {
      files: false,
      patchBytes: false,
      patchUnavailable: false,
    },
  };
}

async function seedGithubAggregate(
  database: DatabaseConnection,
): Promise<void> {
  await database.pool.query(
    `INSERT INTO installations
       (id, github_installation_id, account_id, account_login)
     VALUES ($1, '8101', '8102', 'acme')`,
    [installationId],
  );
  await database.pool.query(
    `INSERT INTO repositories
       (id, installation_id, github_repository_id, owner, name, default_branch)
     VALUES ($1, $2, '8103', 'acme', 'cachekit', 'main')`,
    [repositoryId, installationId],
  );
  await database.pool.query(
    `INSERT INTO pull_requests
       (id, repository_id, github_pull_request_id, number, author_id, state)
     VALUES ($1, $2, '8104', 184, '8105', 'open')`,
    [pullRequestId, repositoryId],
  );
  await database.pool.query(
    `INSERT INTO pull_request_revisions
       (id, pull_request_id, head_sha, base_sha, is_current)
     VALUES ($1, $2, $3, $4, true)`,
    [revisionId, pullRequestId, headSha, "b".repeat(40)],
  );
}

async function count(
  database: DatabaseConnection,
  table: string,
): Promise<number> {
  if (!/^[a-z_]+$/.test(table)) throw new Error("Unsafe test table name");
  const result = await database.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return result.rows[0]?.count ?? 0;
}

async function jobCount(
  database: DatabaseConnection,
  name: string,
  singletonKey: string,
): Promise<number> {
  const result = await database.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM pgboss.job
      WHERE name = $1 AND singleton_key = $2`,
    [name, singletonKey],
  );
  return result.rows[0]?.count ?? 0;
}
