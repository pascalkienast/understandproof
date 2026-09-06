import type { DatabaseConnection } from "@understandproof/db";
import type * as DbModule from "@understandproof/db";
import {
  GithubControlError,
  type GithubCheckRunPort,
  type GithubPullRequestCommentPort,
  type GithubPullRequestHeadPort,
  type GithubPullRequestPort,
  type PullRequestJobPayload,
} from "@understandproof/github";
import type * as GithubModule from "@understandproof/github";
import type { Pool, QueryResult } from "pg";
import type { PgBoss } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  claimGithubCheckSync: vi.fn(),
  completeGithubCheckSync: vi.fn(),
  completeSkippedGithubInvalidationSync: vi.fn(),
  failGithubCheckSync: vi.fn(),
}));
const githubMocks = vi.hoisted(() => ({
  processPullRequestJob: vi.fn(),
  processVerifiedPullRequestSnapshot: vi.fn(),
}));

vi.mock("@understandproof/db", async () => ({
  ...(await vi.importActual<typeof DbModule>("@understandproof/db")),
  ...dbMocks,
}));
vi.mock("@understandproof/github", async () => ({
  ...(await vi.importActual<typeof GithubModule>("@understandproof/github")),
  ...githubMocks,
}));

import {
  handleGithubCheckReconcileJob,
  handleGithubPullRequestJob,
  handleGithubRefreshPullRequestJob,
  sweepDueGithubPullRequestDeliveries,
  sweepDueGithubPullRequestRefreshes,
  type GithubControlDependencies,
} from "./control";

const revisionId = "84000000-0000-4000-8000-000000000001";
const checkRunId = "84000000-0000-4000-8000-000000000002";
const deliveryId = "84000000-0000-4000-8000-000000000003";
const headSha = "a".repeat(40);
const oldBaseSha = "b".repeat(40);
const freshBaseSha = "c".repeat(40);
const now = new Date("2026-08-12T20:00:00.000Z");

describe("GitHub control canonical revision reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.completeGithubCheckSync.mockResolvedValue(true);
    dbMocks.completeSkippedGithubInvalidationSync.mockResolvedValue(true);
    dbMocks.failGithubCheckSync.mockResolvedValue(true);
    githubMocks.processPullRequestJob.mockResolvedValue({
      revisionId,
      createdRevision: true,
      invalidatedAttempts: 0,
    });
    githubMocks.processVerifiedPullRequestSnapshot.mockResolvedValue({
      revisionId,
      createdRevision: true,
      invalidatedAttempts: 0,
    });
  });

  it("accepts a fresh authoritative base when an opened webhook carried the old base", async () => {
    const pullRequests = pullRequestPort(snapshot(freshBaseSha));
    const dependencies = controlDependencies(emptyDatabase(), pullRequests);

    await handleGithubPullRequestJob(webhookPayload(), dependencies);

    expect(pullRequests.load).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedHeadSha: headSha,
        expectedBaseSha: oldBaseSha,
      }),
    );
    expect(githubMocks.processPullRequestJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: "opened",
        pullRequest: expect.objectContaining({ baseSha: freshBaseSha }),
      }),
      expect.anything(),
      expect.objectContaining({
        source: expect.objectContaining({ baseSha: freshBaseSha }),
      }),
    );
  });

  it("uses fresh closed state when an opened webhook became stale", async () => {
    const pullRequests = pullRequestPort({
      ...snapshot(freshBaseSha),
      state: "closed",
    });
    const dependencies = controlDependencies(emptyDatabase(), pullRequests);

    await handleGithubPullRequestJob(webhookPayload(), dependencies);

    expect(githubMocks.processPullRequestJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: "closed",
        pullRequest: expect.objectContaining({ state: "closed" }),
      }),
      expect.anything(),
      expect.objectContaining({
        source: expect.objectContaining({ state: "closed" }),
      }),
    );
  });

  it("uses fresh open state when a closed webhook was overtaken by reopen", async () => {
    const pullRequests = pullRequestPort(snapshot(freshBaseSha));
    const closedPayload = {
      ...webhookPayload(),
      action: "closed" as const,
      pullRequest: {
        ...webhookPayload().pullRequest,
        state: "closed" as const,
      },
    };
    const dependencies = controlDependencies(
      deliveryDatabase(closedPayload),
      pullRequests,
    );

    await handleGithubPullRequestJob(closedPayload, dependencies);

    expect(githubMocks.processPullRequestJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: "synchronize",
        pullRequest: expect.objectContaining({ state: "open" }),
      }),
      expect.anything(),
      expect.objectContaining({
        source: expect.objectContaining({ state: "open" }),
      }),
    );
  });

  it("recovers an initially unknown stale tuple from the signed delivery snapshot", async () => {
    const pullRequests = pullRequestPort(snapshot(freshBaseSha));
    vi.mocked(pullRequests.load)
      .mockRejectedValueOnce(new GithubControlError("STALE_HEAD"))
      .mockResolvedValueOnce(snapshot(freshBaseSha));
    const dependencies = controlDependencies(emptyDatabase(), pullRequests);

    await expect(
      handleGithubPullRequestJob(webhookPayload(), dependencies),
    ).resolves.toBeUndefined();

    expect(pullRequests.getCurrentHead).toHaveBeenCalledOnce();
    expect(pullRequests.load).toHaveBeenCalledTimes(2);
    expect(githubMocks.processPullRequestJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: "synchronize",
        pullRequest: expect.objectContaining({ baseSha: freshBaseSha }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not mint GitHub credentials for a pending installation", async () => {
    const database = deliveryDatabase(webhookPayload(), "pending", "active");
    const pullRequests = pullRequestPort(snapshot(oldBaseSha));
    const dependencies = controlDependencies(database, pullRequests);

    await expect(
      handleGithubPullRequestJob(webhookPayload(), dependencies),
    ).resolves.toBeUndefined();

    expect(pullRequests.load).not.toHaveBeenCalled();
    expect(pullRequests.loadFresh).not.toHaveBeenCalled();
    expect(githubMocks.processPullRequestJob).not.toHaveBeenCalled();
  });

  it("forces fresh installation authorization before an inactive binding can be reactivated", async () => {
    const database = deliveryDatabase(
      webhookPayload(),
      "suspended",
      "suspended",
    );
    const pullRequests = pullRequestPort(snapshot(oldBaseSha));
    const dependencies = controlDependencies(database, pullRequests);

    await handleGithubPullRequestJob(webhookPayload(), dependencies);

    expect(pullRequests.loadFresh).toHaveBeenCalledOnce();
    expect(pullRequests.load).not.toHaveBeenCalled();
    expect(githubMocks.processPullRequestJob).toHaveBeenCalledOnce();
  });

  it("keeps an inactive binding tombstoned when fresh authorization is rejected", async () => {
    const database = deliveryDatabase(webhookPayload(), "suspended", "removed");
    const pullRequests = pullRequestPort(snapshot(oldBaseSha));
    vi.mocked(pullRequests.loadFresh!).mockRejectedValueOnce(
      new GithubControlError("REJECTED", { status: 403 }),
    );
    const dependencies = controlDependencies(database, pullRequests);

    await expect(
      handleGithubPullRequestJob(webhookPayload(), dependencies),
    ).resolves.toBeUndefined();

    expect(pullRequests.load).not.toHaveBeenCalled();
    expect(githubMocks.processPullRequestJob).not.toHaveBeenCalled();
  });

  it("acknowledges an immediate queue retry while its durable Retry-After is still in the future", async () => {
    let retryDeferred = false;
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes("SELECT processing_status, job_payload")) {
          return queryResult([
            {
              processing_status: "queued",
              job_payload: webhookPayload(),
              retry_deferred: retryDeferred,
            },
          ]);
        }
        if (sql.includes("SELECT retry_attempts")) {
          return queryResult([
            {
              retry_attempts: 0,
              processing_status: "queued",
              job_payload: webhookPayload(),
            },
          ]);
        }
        if (sql.includes("SET retry_attempts")) {
          retryDeferred = true;
          return { ...queryResult([]), rowCount: 1 };
        }
        return queryResult([]);
      }),
      release: vi.fn(),
    };
    const database = {
      pool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async (sql: string) =>
          sql.includes("FROM installations")
            ? queryResult([
                {
                  github_installation_id: "101",
                  status: "active",
                  version: "2026-08-12 20:00:00+00",
                },
              ])
            : queryResult([
                {
                  github_repository_id: "102",
                  github_installation_id: "101",
                  status: "active",
                  owner: "acme",
                  name: "widgets",
                  version: "2026-08-12 20:00:00+00",
                },
              ]),
        ),
      } as unknown as Pool,
      db: {} as DatabaseConnection["db"],
      close: vi.fn(async () => undefined),
    };
    const pullRequests = pullRequestPort(snapshot(oldBaseSha));
    vi.mocked(pullRequests.load).mockRejectedValue(
      new GithubControlError("RATE_LIMITED", { retryAfterMs: 600_000 }),
    );
    const dependencies = controlDependencies(database, pullRequests);

    await expect(
      handleGithubPullRequestJob(webhookPayload(), dependencies),
    ).resolves.toBeUndefined();
    await expect(
      handleGithubPullRequestJob(webhookPayload(), dependencies),
    ).resolves.toBeUndefined();

    expect(pullRequests.load).toHaveBeenCalledTimes(1);
    expect(
      statements.find((call) => call.sql.includes("SET retry_attempts"))
        ?.values,
    ).toEqual([deliveryId, 1, 600_000]);
  });

  it("acknowledges a permanent delivery failure so the next valid FIFO job can run", async () => {
    const nextPayload: PullRequestJobPayload = {
      ...webhookPayload(),
      deliveryId: "84000000-0000-4000-8000-000000000004",
      idempotencyKey: "github:delivery:synchronize",
      action: "synchronize",
    };
    const deliveries = new Map([
      [deliveryId, { status: "queued", payload: webhookPayload() }],
      [nextPayload.deliveryId, { status: "queued", payload: nextPayload }],
    ]);
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        const id = String(values[0] ?? "");
        const delivery = deliveries.get(id);
        if (sql.includes("SELECT processing_status, job_payload")) {
          return delivery
            ? queryResult([
                {
                  processing_status: delivery.status,
                  job_payload: delivery.payload,
                  retry_deferred: false,
                },
              ])
            : queryResult([]);
        }
        if (sql.includes("SET processing_status = 'permanent_failure'")) {
          if (delivery) delivery.status = "permanent_failure";
          return { ...queryResult([]), rowCount: delivery ? 1 : 0 };
        }
        return queryResult([]);
      }),
      release: vi.fn(),
    };
    const database = {
      pool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () =>
          queryResult([
            {
              github_installation_id: "101",
              installation_status: "active",
              repository_status: "active",
              owner: "acme",
              name: "widgets",
            },
          ]),
        ),
      } as unknown as Pool,
      db: {} as DatabaseConnection["db"],
      close: vi.fn(async () => undefined),
    };
    const dependencies = controlDependencies(
      database,
      pullRequestPort(snapshot(oldBaseSha)),
    );
    githubMocks.processPullRequestJob
      .mockRejectedValueOnce(new GithubControlError("INVALID_RESPONSE"))
      .mockResolvedValueOnce({
        revisionId,
        createdRevision: false,
        invalidatedAttempts: 0,
      });

    await expect(
      handleGithubPullRequestJob(webhookPayload(), dependencies),
    ).resolves.toBeUndefined();
    await expect(
      handleGithubPullRequestJob(nextPayload, dependencies),
    ).resolves.toBeUndefined();

    expect(deliveries.get(deliveryId)?.status).toBe("permanent_failure");
    expect(githubMocks.processPullRequestJob).toHaveBeenCalledTimes(2);
  });

  it("routes base drift through the repository FIFO before any remote Check write", async () => {
    dbMocks.claimGithubCheckSync.mockResolvedValue(claimedCheck());
    const database = targetDatabase();
    const pullRequests = pullRequestPort(snapshot(freshBaseSha));
    const checkRuns = checkRunPort();
    const dependencies = controlDependencies(database, pullRequests, checkRuns);

    await handleGithubCheckReconcileJob(checkJob(), dependencies);

    expect(dependencies.queue.upsert).toHaveBeenCalledWith(
      "github.ingest-pr",
      expect.objectContaining({
        eventName: "pull_request_refresh",
        repositoryId: "102",
        pullNumber: 17,
      }),
      expect.objectContaining({
        singletonKey: "102:17",
        match: "oldest",
        startAfter: expect.any(Date),
      }),
    );
    expect(githubMocks.processPullRequestJob).not.toHaveBeenCalled();
    expect(checkRuns.create).not.toHaveBeenCalled();
    expect(checkRuns.update).not.toHaveBeenCalled();
    expect(dbMocks.completeGithubCheckSync).not.toHaveBeenCalled();
    expect(dbMocks.failGithubCheckSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ retryable: true }),
    );
  });

  it("updates the App-owned contributor comment before completing a current Check sync", async () => {
    dbMocks.claimGithubCheckSync.mockResolvedValue(claimedCheck());
    const comments = commentPort();
    const dependencies = controlDependencies(
      targetDatabase(),
      pullRequestPort(snapshot(oldBaseSha)),
      checkRunPort(),
      comments,
    );

    await expect(
      handleGithubCheckReconcileJob(checkJob(), dependencies),
    ).resolves.toBeUndefined();

    expect(comments.upsert).toHaveBeenCalledWith({
      installationId: "101",
      repositoryId: "102",
      owner: "acme",
      repositoryName: "widgets",
      pullNumber: 17,
      revisionId,
      headSha,
      baseSha: oldBaseSha,
      expectedPullRequestState: "open",
      detailsUrl: `https://slopproof.test/revisions/${revisionId}`,
    });
    expect(dbMocks.completeGithubCheckSync).toHaveBeenCalledOnce();
    expect(vi.mocked(comments.upsert).mock.invocationCallOrder[0]).toBeLessThan(
      dbMocks.completeGithubCheckSync.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("refreshes a moved head from the active DB binding without a synthetic delivery", async () => {
    const pullRequests = pullRequestPort(snapshot(freshBaseSha));
    vi.mocked(pullRequests.getCurrentHead).mockResolvedValueOnce({
      headSha: "d".repeat(40),
      baseSha: freshBaseSha,
      state: "open",
    });
    vi.mocked(pullRequests.load).mockResolvedValueOnce({
      ...snapshot(freshBaseSha),
      headSha: "d".repeat(40),
    });
    const dependencies = controlDependencies(targetDatabase(), pullRequests);

    await handleGithubRefreshPullRequestJob(
      {
        schemaVersion: "1",
        idempotencyKey: "github:refresh:102:17:old",
        eventName: "pull_request_refresh",
        installationId: "101",
        repositoryId: "102",
        owner: "acme",
        repositoryName: "widgets",
        pullNumber: 17,
        expectedHeadSha: headSha,
      },
      dependencies,
    );

    expect(githubMocks.processVerifiedPullRequestSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: "synchronize",
        pullRequest: expect.objectContaining({
          headSha: "d".repeat(40),
          baseSha: freshBaseSha,
        }),
      }),
      expect.anything(),
      expect.objectContaining({
        source: expect.objectContaining({ headSha: "d".repeat(40) }),
      }),
    );
    const operation = githubMocks.processVerifiedPullRequestSnapshot.mock
      .calls[0]?.[2] as unknown as Record<string, unknown>;
    expect(operation).not.toHaveProperty("deliveryId");
  });

  it("claims due open PR refreshes with SKIP LOCKED and advances their durable schedule", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("SELECT pull_request.id")) {
          return queryResult([
            {
              id: "86000000-0000-4000-8000-000000000001",
              installation_id: "101",
              repository_id: "102",
              owner: "acme",
              name: "widgets",
              number: 17,
              head_sha: headSha,
              base_sha: oldBaseSha,
            },
          ]);
        }
        return queryResult([]);
      }),
      release: vi.fn(),
    };
    const database = {
      pool: { connect: vi.fn(async () => client) } as unknown as Pool,
      db: {} as DatabaseConnection["db"],
      close: vi.fn(async () => undefined),
    };
    const dependencies = controlDependencies(
      database,
      pullRequestPort(snapshot(oldBaseSha)),
    );

    await expect(
      sweepDueGithubPullRequestRefreshes(dependencies),
    ).resolves.toEqual({ examined: 1, published: 1 });
    expect(
      statements.some((sql) =>
        sql.includes("FOR UPDATE OF pull_request SKIP LOCKED"),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes("next_github_refresh_at = now() + interval '2 minutes'"),
      ),
    ).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("replays a durable webhook payload after its queue lease expires", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("SELECT delivery_id, job_payload")) {
          return queryResult([
            { delivery_id: deliveryId, job_payload: webhookPayload() },
          ]);
        }
        return queryResult([]);
      }),
      release: vi.fn(),
    };
    const database = {
      pool: { connect: vi.fn(async () => client) } as unknown as Pool,
      db: {} as DatabaseConnection["db"],
      close: vi.fn(async () => undefined),
    };
    const dependencies = controlDependencies(
      database,
      pullRequestPort(snapshot(oldBaseSha)),
    );

    await expect(
      sweepDueGithubPullRequestDeliveries(dependencies),
    ).resolves.toEqual({ examined: 1, published: 1 });
    expect(
      statements.some((sql) => sql.includes("FOR UPDATE SKIP LOCKED")),
    ).toBe(true);
    expect(statements.some((sql) => sql.includes("next_retry_at = NULL"))).toBe(
      true,
    );
  });

  it("parks a retry-limited refresh beyond the queue horizon and acknowledges the job", async () => {
    const pullRequests = pullRequestPort(snapshot(oldBaseSha));
    vi.mocked(pullRequests.getCurrentHead).mockRejectedValueOnce(
      new GithubControlError("RATE_LIMITED", { retryAfterMs: 600_000 }),
    );
    const database = targetDatabase();
    const dependencies = controlDependencies(database, pullRequests);

    await expect(
      handleGithubRefreshPullRequestJob(
        {
          schemaVersion: "1",
          idempotencyKey: "github:refresh:rate-limit",
          eventName: "pull_request_refresh",
          installationId: "101",
          repositoryId: "102",
          owner: "acme",
          repositoryName: "widgets",
          pullNumber: 17,
          expectedHeadSha: headSha,
        },
        dependencies,
      ),
    ).resolves.toBeUndefined();
    expect(database.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("now() + ($2::bigint"),
      ["104", 600_000],
    );
  });

  it("parks STALE_HEAD durably instead of recording a permanent failure", async () => {
    dbMocks.claimGithubCheckSync.mockResolvedValue(claimedCheck());
    const pullRequests = pullRequestPort(snapshot(oldBaseSha));
    vi.mocked(pullRequests.load).mockRejectedValueOnce(
      new GithubControlError("STALE_HEAD"),
    );
    const dependencies = controlDependencies(
      targetDatabase(),
      pullRequests,
      checkRunPort(),
    );

    await expect(
      handleGithubCheckReconcileJob(checkJob(), dependencies),
    ).resolves.toBeUndefined();
    expect(dbMocks.failGithubCheckSync).toHaveBeenCalledWith(
      expect.anything(),
      {
        checkRunId,
        attempt: 1,
        errorClass: "StaleHead",
        retryable: true,
        nextSyncAfter: new Date(now.getTime() + 15_000),
      },
    );
  });

  it("synchronizes an authoritative closed webhook as cancelled without a refresh loop", async () => {
    dbMocks.claimGithubCheckSync.mockResolvedValue({
      ...claimedCheck(),
      status: "completed",
      conclusion: "cancelled",
      intentReason: "webhook_ingested",
    });
    const pullRequests = pullRequestPort({
      ...snapshot(oldBaseSha),
      state: "closed",
    });
    const checkRuns = checkRunPort();
    const comments = commentPort();
    const dependencies = controlDependencies(
      targetDatabase(),
      pullRequests,
      checkRuns,
      comments,
    );

    await expect(
      handleGithubCheckReconcileJob(checkJob(), dependencies),
    ).resolves.toBeUndefined();

    expect(checkRuns.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        conclusion: "cancelled",
      }),
    );
    expect(dependencies.queue.upsert).not.toHaveBeenCalled();
    expect(dbMocks.completeGithubCheckSync).toHaveBeenCalledOnce();
    expect(comments.upsert).not.toHaveBeenCalled();
    expect(dbMocks.failGithubCheckSync).not.toHaveBeenCalled();
  });

  it("queues a FIFO refresh when the ref moves during the final Check write", async () => {
    dbMocks.claimGithubCheckSync.mockResolvedValue(claimedCheck());
    const pullRequests = pullRequestPort(snapshot(oldBaseSha));
    const checkRuns = checkRunPort();
    vi.mocked(checkRuns.create).mockRejectedValueOnce(
      new GithubControlError("STALE_HEAD"),
    );
    const dependencies = controlDependencies(
      targetDatabase(),
      pullRequests,
      checkRuns,
    );

    await expect(
      handleGithubCheckReconcileJob(checkJob(), dependencies),
    ).resolves.toBeUndefined();
    expect(dependencies.queue.upsert).toHaveBeenCalledWith(
      "github.ingest-pr",
      expect.objectContaining({ eventName: "pull_request_refresh" }),
      expect.objectContaining({ singletonKey: "102:17" }),
    );
    expect(dbMocks.failGithubCheckSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        errorClass: "StaleHead",
        retryable: true,
        nextSyncAfter: new Date(now.getTime() + 15_000),
      }),
    );
  });

  it("durably schedules ordinary retryable failures with exponential backoff", async () => {
    dbMocks.claimGithubCheckSync.mockResolvedValue({
      ...claimedCheck(),
      attempt: 3,
    });
    const pullRequests = pullRequestPort(snapshot(oldBaseSha));
    const checkRuns = checkRunPort();
    vi.mocked(checkRuns.create).mockRejectedValueOnce(new Error("outage"));
    const dependencies = controlDependencies(
      targetDatabase(),
      pullRequests,
      checkRuns,
    );

    await expect(
      handleGithubCheckReconcileJob(checkJob(), dependencies),
    ).resolves.toBeUndefined();
    expect(dbMocks.failGithubCheckSync).toHaveBeenCalledWith(
      expect.anything(),
      {
        checkRunId,
        attempt: 3,
        errorClass: "Unavailable",
        retryable: true,
        nextSyncAfter: new Date(now.getTime() + 8_000),
      },
    );
  });
});

function controlDependencies(
  database: DatabaseConnection,
  pullRequests: GithubPullRequestPort & GithubPullRequestHeadPort,
  checkRuns: GithubCheckRunPort = checkRunPort(),
  pullRequestComments: GithubPullRequestCommentPort = commentPort(),
): GithubControlDependencies {
  return {
    database,
    queue: {
      send: vi.fn(async () => "85000000-0000-4000-8000-000000000001"),
      findJobs: vi.fn(async () => []),
      retry: vi.fn(async () => undefined),
      update: vi.fn(async () => ({ updated: 1 })),
      upsert: vi.fn(async () => ({
        jobs: ["85000000-0000-4000-8000-000000000001"],
        inserted: 1,
        updated: 0,
      })),
    } as unknown as PgBoss,
    appBaseUrl: "https://slopproof.test",
    adapter: "octokit",
    pullRequests,
    checkRuns,
    pullRequestComments,
    clock: { now: () => now },
  };
}

function emptyDatabase(): DatabaseConnection {
  return deliveryDatabase(webhookPayload());
}

function deliveryDatabase(
  persistedPayload: PullRequestJobPayload,
  installationStatus = "active",
  repositoryStatus = "active",
): DatabaseConnection {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT processing_status, job_payload")) {
        return queryResult([
          {
            processing_status: "queued",
            job_payload: persistedPayload,
            retry_deferred: false,
          },
        ]);
      }
      return queryResult([]);
    }),
    release: vi.fn(),
  };
  return {
    pool: {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM installations")) {
          return queryResult([
            {
              github_installation_id:
                persistedPayload.installation.githubInstallationId,
              status: installationStatus,
              version: "2026-08-12 20:00:00+00",
            },
          ]);
        }
        return queryResult([
          {
            github_repository_id:
              persistedPayload.repository.githubRepositoryId,
            github_installation_id:
              persistedPayload.installation.githubInstallationId,
            status: repositoryStatus,
            owner: persistedPayload.repository.owner,
            name: persistedPayload.repository.name,
            version: "2026-08-12 20:00:00+00",
          },
        ]);
      }),
      connect: vi.fn(async () => client),
    } as unknown as Pool,
    db: {} as DatabaseConnection["db"],
    close: vi.fn(async () => undefined),
  };
}

function targetDatabase(): DatabaseConnection {
  const row = {
    revision_id: revisionId,
    head_sha: headSha,
    base_sha: oldBaseSha,
    number: 17,
    github_pull_request_id: "104",
    author_id: "105",
    github_repository_id: "102",
    owner: "acme",
    name: "widgets",
    default_branch: "main",
    github_installation_id: "101",
    account_id: "103",
    account_login: "acme",
    bound_installation_id: "101",
    bound_account_id: "103",
    bound_account_login: "acme",
    target_installation_id: "101",
    target_account_id: "103",
    target_account_login: "acme",
    repository_status: "active",
    installation_status: "active",
    bound_installation_status: "active",
    target_installation_status: "active",
    repository_version: "2026-08-12 20:00:00+00",
    target_installation_version: "2026-08-12 20:00:00+00",
    github_recovery_binding: null,
  };
  return {
    pool: {
      query: vi.fn(async () => queryResult([row])),
    } as unknown as Pool,
    db: {} as DatabaseConnection["db"],
    close: vi.fn(async () => undefined),
  };
}

function pullRequestPort(
  result: ReturnType<typeof snapshot>,
): GithubPullRequestPort & GithubPullRequestHeadPort {
  return {
    load: vi.fn(async () => result),
    loadFresh: vi.fn(async () => result),
    getCurrentHead: vi.fn(async () => ({
      headSha: result.headSha,
      baseSha: result.baseSha,
      state: result.state,
    })),
    getCurrentHeadFresh: vi.fn(async () => ({
      headSha: result.headSha,
      baseSha: result.baseSha,
      state: result.state,
    })),
  };
}

function checkRunPort(): GithubCheckRunPort {
  return {
    create: vi.fn(async () => ({ checkRunId: "9001" })),
    update: vi.fn(async () => ({ checkRunId: "9001" })),
    invalidateStale: vi.fn(async () => ({ checkRunId: "9001" })),
    findExisting: vi.fn(async () => null),
  };
}

function commentPort(): GithubPullRequestCommentPort {
  return { upsert: vi.fn(async () => undefined) };
}

function snapshot(
  baseSha: string,
): Awaited<ReturnType<GithubPullRequestPort["load"]>> {
  return {
    githubPullRequestId: "104",
    number: 17,
    state: "open",
    draft: false,
    title: "Move the target branch",
    body: null,
    authorId: "105",
    authorLogin: "octocat",
    headSha,
    baseSha,
    changedFiles: 1,
    isFork: false,
    files: [
      {
        sha: headSha,
        filename: "src/index.ts",
        previousFilename: null,
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -1 +1 @@",
        gitKind: "blob" as const,
      },
    ],
    limitsHit: { files: false, patchBytes: false, patchUnavailable: false },
  };
}

function webhookPayload(): PullRequestJobPayload {
  return {
    schemaVersion: "1",
    idempotencyKey: "github:delivery:opened",
    deliveryId,
    eventName: "pull_request",
    action: "opened",
    installation: {
      githubInstallationId: "101",
      accountId: "103",
      accountLogin: "acme",
    },
    repository: {
      githubRepositoryId: "102",
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
    },
    pullRequest: {
      githubPullRequestId: "104",
      number: 17,
      state: "open",
      authorId: "105",
      headSha,
      baseSha: oldBaseSha,
    },
  };
}

function checkJob() {
  return {
    schemaVersion: "1" as const,
    idempotencyKey: "check:intent:base-drift",
    revisionId,
    expectedHeadSha: headSha,
    reason: "webhook_ingested" as const,
  };
}

function claimedCheck() {
  return {
    checkRunId,
    attempt: 1,
    githubCheckRunId: null,
    name: "UnderstandProof / understanding required",
    status: "in_progress" as const,
    conclusion: null,
    publicSummary: "understanding required",
    detailsUrl: `https://slopproof.test/revisions/${revisionId}`,
    intentReason: "webhook_ingested" as const,
  };
}

function queryResult<Row extends Record<string, unknown>>(
  rows: Row[],
): QueryResult<Row> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}
