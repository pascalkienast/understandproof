import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accelerateEvidenceDeletionAfterPass } from "../../apps/web/lib/maintainer-review";
import {
  connectDatabase,
  migrateDatabase,
  persistPendingUploadFinalization,
  type DatabaseConnection,
} from "@understandproof/db";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const ids = {
  installation: "10000000-0000-4000-8000-000000000001",
  repository: "10000000-0000-4000-8000-000000000002",
  pullRequest: "10000000-0000-4000-8000-000000000003",
  revision: "10000000-0000-4000-8000-000000000004",
  policy: "10000000-0000-4000-8000-000000000005",
  plan: "10000000-0000-4000-8000-000000000006",
  attempt: "10000000-0000-4000-8000-000000000007",
  session: "10000000-0000-4000-8000-000000000008",
  handoff: "10000000-0000-4000-8000-000000000009",
} as const;

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

databaseDescribe("PostgreSQL domain constraints", () => {
  let connection: DatabaseConnection;

  beforeAll(async () => {
    connection = connectDatabase(databaseUrl!);
    await migrateDatabase(connection.pool);
    await migrateDatabase(connection.pool);
  });

  afterAll(async () => {
    await connection.close();
  });

  beforeEach(async () => {
    await connection.pool.query(`
      TRUNCATE TABLE
        audit_events, deletion_jobs, check_runs, review_decisions, evaluations,
        frame_selections, transcripts, recording_objects, recording_parts,
        upload_sessions, wrapping_materials, handoff_tokens, auth_sessions,
        attempt_transitions, attempts, proof_questions, proof_plans,
        practice_sessions, analysis_snapshots, webhook_deliveries,
        pull_request_revisions, pull_requests, repository_policies,
        repositories, installations, github_app_account_allowlist
      RESTART IDENTITY CASCADE
    `);
    await seedCore(connection);
  });

  it("deduplicates webhook deliveries and current revisions in PostgreSQL", async () => {
    await connection.pool.query(
      "INSERT INTO webhook_deliveries (delivery_id, event_name, payload_hash) VALUES ($1, $2, $3)",
      ["delivery-1", "pull_request", "c".repeat(64)],
    );
    await expect(
      connection.pool.query(
        "INSERT INTO webhook_deliveries (delivery_id, event_name, payload_hash) VALUES ($1, $2, $3)",
        ["delivery-1", "pull_request", "c".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      connection.pool.query(
        `INSERT INTO pull_request_revisions
          (id, pull_request_id, head_sha, base_sha, is_current)
         VALUES ($1, $2, $3, $4, true)`,
        [
          "20000000-0000-4000-8000-000000000001",
          ids.pullRequest,
          "d".repeat(40),
          baseSha,
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await connection.pool.query(
      "UPDATE pull_request_revisions SET is_current = false, invalidated_at = now() WHERE id = $1",
      [ids.revision],
    );
    await expect(
      connection.pool.query(
        `INSERT INTO pull_request_revisions
          (id, pull_request_id, head_sha, base_sha, is_current)
         VALUES ($1, $2, $3, $4, true)`,
        [
          "20000000-0000-4000-8000-000000000001",
          ids.pullRequest,
          "d".repeat(40),
          baseSha,
        ],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("allows only one nonterminal attempt per author and revision", async () => {
    await insertAttempt(connection, ids.attempt, "preparing");
    await expect(
      insertAttempt(
        connection,
        "20000000-0000-4000-8000-000000000002",
        "ready",
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await connection.pool.query(
      "UPDATE attempts SET status = 'technical_retry', completed_at = now() WHERE id = $1",
      [ids.attempt],
    );
    await expect(
      insertAttempt(
        connection,
        "20000000-0000-4000-8000-000000000002",
        "ready",
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("freezes proof plans after attempt creation and keeps audit rows append-only", async () => {
    const questionId = "20000000-0000-4000-8000-000000000000";
    await connection.pool.query(
      `INSERT INTO proof_questions
        (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
       VALUES ($1, $2, 0, 'explain', 'Explain the exact behavior.', '{}', '{}', true)`,
      [questionId, ids.plan],
    );
    await insertAttempt(connection, ids.attempt, "preparing");
    await expect(
      connection.pool.query(
        "UPDATE proof_plans SET question_budget = 2 WHERE id = $1",
        [ids.plan],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      connection.pool.query(
        `INSERT INTO proof_questions
          (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
         VALUES ($1, $2, 0, 'explain', 'Explain the exact behavior.', '{}', '{}', true)
         ON CONFLICT (proof_plan_id, ordinal) DO NOTHING`,
        [questionId, ids.plan],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      connection.pool.query(
        `INSERT INTO proof_questions
          (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
         VALUES ($1, $2, 1, 'explain', 'Late mutable question.', '{}', '{}', true)`,
        ["20000000-0000-4000-8000-000000000099", ids.plan],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const audit = await connection.pool.query<{ id: string }>(
      `INSERT INTO audit_events (actor_id, action, object_type, object_id, metadata)
       VALUES ('system', 'attempt.created', 'attempt', $1, '{}') RETURNING id`,
      [ids.attempt],
    );
    await expect(
      connection.pool.query(
        "UPDATE audit_events SET action = 'changed' WHERE id = $1",
        [audit.rows[0]?.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("binds every proof plan to an append-only policy from the same repository", async () => {
    const secondInstallation = "20000000-0000-4000-8000-000000000010";
    const secondRepository = "20000000-0000-4000-8000-000000000011";
    const secondPolicy = "20000000-0000-4000-8000-000000000012";
    const secondPullRequest = "20000000-0000-4000-8000-000000000013";
    const secondRevision = "20000000-0000-4000-8000-000000000014";
    const secondPlan = "20000000-0000-4000-8000-000000000015";
    await connection.pool.query(
      `INSERT INTO installations
        (id, github_installation_id, account_id, account_login)
       VALUES ($1, 'installation-2', 'account-2', 'other')`,
      [secondInstallation],
    );
    await connection.pool.query(
      `INSERT INTO repositories
        (id, installation_id, github_repository_id, owner, name, default_branch)
       VALUES ($1, $2, 'repository-2', 'other', 'repo', 'main')`,
      [secondRepository, secondInstallation],
    );
    await connection.pool.query(
      `INSERT INTO repository_policies
        (id, repository_id, version, schema_version, policy, policy_hash,
         created_by, activated_at)
       VALUES ($1, $2, 1, '1', '{"decisionMode":"maintainer_review"}', $3,
               'system', now())`,
      [secondPolicy, secondRepository, "a".repeat(64)],
    );

    await expect(
      connection.pool.query(
        "UPDATE proof_plans SET repository_policy_id = $2 WHERE id = $1",
        [ids.plan, secondPolicy],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection.pool.query(
        "UPDATE repository_policies SET policy_hash = $2 WHERE id = $1",
        [ids.policy, "b".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await connection.pool.query(
      `INSERT INTO pull_requests
        (id, repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, 'pull-2', 185, 'github-user-42', 'open')`,
      [secondPullRequest, secondRepository],
    );
    await connection.pool.query(
      `INSERT INTO pull_request_revisions
        (id, pull_request_id, head_sha, base_sha, is_current)
       VALUES ($1, $2, $3, $4, true)`,
      [secondRevision, secondPullRequest, "c".repeat(40), "d".repeat(40)],
    );
    await connection.pool.query(
      `INSERT INTO proof_plans
        (id, revision_id, repository_policy_id, plan_version,
         deterministic_seed, risk_explanation, question_budget, plan_hash, status)
       VALUES ($1, $2, $3, 'planner-v1', 'seed-2', '{}', 1, $4, 'ready')`,
      [secondPlan, secondRevision, secondPolicy, "c".repeat(64)],
    );
    await expect(
      connection.pool.query(
        `INSERT INTO attempts
          (repository_id, revision_id, author_id, proof_plan_id, head_sha,
           status, nonce_hash, expires_at)
         VALUES ($1, $2, 'github-user-42', $3, $4, 'ready', $5,
                 now() + interval '1 hour')`,
        [ids.repository, ids.revision, secondPlan, headSha, "4".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await insertAttempt(connection, ids.attempt, "ready");
    await expect(
      connection.pool.query(
        "UPDATE attempts SET proof_plan_id = $2 WHERE id = $1",
        [ids.attempt, secondPlan],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("freezes the accepted evidence deadline and enforces it on every artifact", async () => {
    const deadline = new Date("2030-01-02T00:00:00.000Z");
    const wrappingMaterial = "20000000-0000-4000-8000-000000000020";
    const objectId = "20000000-0000-4000-8000-000000000021";
    await insertAttempt(connection, ids.attempt, "ready");
    await connection.pool.query(
      "UPDATE attempts SET evidence_delete_after = $2 WHERE id = $1",
      [ids.attempt, deadline],
    );
    await expect(
      connection.pool.query(
        "UPDATE attempts SET evidence_delete_after = $2 WHERE id = $1",
        [ids.attempt, new Date(deadline.getTime() + 1)],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await connection.pool.query(
      `INSERT INTO wrapping_materials
        (id, attempt_id, object_id, key_id, algorithm, spki_sha256, usable_until)
       VALUES ($1, $2, $3, 'key-1', 'RSA-OAEP-256', $4, $5)`,
      [wrappingMaterial, ids.attempt, objectId, "c".repeat(64), deadline],
    );
    await expect(
      connection.pool.query(
        `INSERT INTO recording_objects
          (attempt_id, object_key, wrapped_data_key, wrapped_key_sha256,
           wrapping_material_id, protocol_version, algorithm, byte_length,
           duration_ms, codec, manifest_hash, delete_after)
         VALUES ($1, 'evidence/wrong.enc', 'wrapped', $2, $3, 'SP-RC1',
                 'AES-256-GCM', 1024, 1000, 'video/webm;codecs=vp8,opus', $4, $5)`,
        [
          ids.attempt,
          "d".repeat(64),
          wrappingMaterial,
          "e".repeat(64),
          new Date(deadline.getTime() + 1),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("sets the evidence deadline once when finalization is accepted and preserves it on replay", async () => {
    const uploadSession = "20000000-0000-4000-8000-000000000030";
    const objectId = "20000000-0000-4000-8000-000000000031";
    const acceptedDeadline = new Date("2030-01-02T00:00:00.000Z");
    await insertAttempt(connection, ids.attempt, "uploading");
    await connection.pool.query(
      `INSERT INTO upload_sessions
        (id, attempt_id, object_id, object_key, provider_upload_id, state,
         expires_at)
       VALUES ($1, $2, $3, 'evidence/finalize.enc', 'provider-finalize',
               'active', '2030-01-01T00:00:00.000Z')`,
      [uploadSession, ids.attempt, objectId],
    );
    const jobId = "20000000-0000-4000-8000-000000000032";
    let queued = 0;
    let retried = 0;
    let updated = 0;
    let jobState: "created" | "failed" | "retry" | undefined;
    const queue = {
      async findJobs() {
        return jobState === undefined ? [] : [{ id: jobId, state: jobState }];
      },
      async retry(_name: string, recoveredJobId: string) {
        expect(recoveredJobId).toBe(jobId);
        retried += 1;
        jobState = "retry";
      },
      async update(_name: string, _payload: unknown, options: { id: string }) {
        expect(options.id).toBe(jobId);
        updated += 1;
        return { updated: 1 };
      },
      async upsert() {
        if (jobState !== undefined) return { jobs: [] };
        queued += 1;
        jobState = "created";
        return { jobs: [jobId] };
      },
    } as unknown as Parameters<typeof persistPendingUploadFinalization>[1];
    const input = {
      uploadSessionId: uploadSession,
      attemptId: ids.attempt,
      expectedHeadSha: headSha,
      manifestDigest: "2".repeat(64),
      finalizeEnvelope: { schemaVersion: "test" },
      actorId: "github-user-42",
      idempotencyKey: "upload-finalize:integration",
      evidenceDeleteAfter: acceptedDeadline,
    };
    await expect(
      persistPendingUploadFinalization(connection.db, queue, input),
    ).resolves.toEqual({ replay: false });
    await expect(
      persistPendingUploadFinalization(connection.db, queue, {
        ...input,
        evidenceDeleteAfter: new Date("2030-01-03T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ replay: true });

    jobState = "failed";
    await expect(
      persistPendingUploadFinalization(connection.db, queue, input),
    ).resolves.toEqual({ replay: true });

    const attempt = await connection.pool.query<{
      status: string;
      evidence_delete_after: Date;
    }>("SELECT status, evidence_delete_after FROM attempts WHERE id = $1", [
      ids.attempt,
    ]);
    expect(attempt.rows[0]).toMatchObject({
      status: "processing",
      evidence_delete_after: acceptedDeadline,
    });
    expect(queued).toBe(1);
    expect(retried).toBe(1);
    expect(updated).toBe(1);
  });

  it("atomically binds an exact authenticated question interval set before queueing media", async () => {
    const questionId = "20000000-0000-4000-8000-000000000033";
    const uploadSession = "20000000-0000-4000-8000-000000000034";
    const objectId = "20000000-0000-4000-8000-000000000035";
    const manifestDigest = "3".repeat(64);
    await connection.pool.query(
      `INSERT INTO proof_questions
        (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
       VALUES ($1, $2, 0, 'explain', 'Explain the exact behavior.', '{}', '{}', true)`,
      [questionId, ids.plan],
    );
    await insertAttempt(connection, ids.attempt, "uploading");
    await connection.pool.query(
      `INSERT INTO upload_sessions
        (id, attempt_id, object_id, object_key, provider_upload_id, state,
         expires_at)
       VALUES ($1, $2, $3, 'evidence/interval.enc', 'provider-interval',
               'active', '2030-01-01T00:00:00.000Z')`,
      [uploadSession, ids.attempt, objectId],
    );
    let queued = 0;
    let jobExists = false;
    const queue = {
      async findJobs() {
        return jobExists
          ? [
              {
                id: "20000000-0000-4000-8000-000000000036",
                state: "created",
              },
            ]
          : [];
      },
      async upsert() {
        if (jobExists) return { jobs: [] };
        jobExists = true;
        queued += 1;
        return { jobs: ["20000000-0000-4000-8000-000000000036"] };
      },
    } as unknown as Parameters<typeof persistPendingUploadFinalization>[1];
    const interval = (endMs: number) => ({
      schemaVersion: "1" as const,
      intervalVersion: "proof-question-interval-v1" as const,
      questionId,
      ordinal: 0,
      startMs: 0,
      endMs,
      recordedDurationMs: endMs,
      source: "mobile_navigation_v1" as const,
    });
    const input = (endMs: number) => ({
      uploadSessionId: uploadSession,
      attemptId: ids.attempt,
      expectedHeadSha: headSha,
      manifestDigest,
      finalizeEnvelope: {
        manifest: { durationMs: endMs, questionIntervals: [interval(endMs)] },
      },
      actorId: "github-user-42",
      idempotencyKey: "upload-finalize:interval-integration",
      evidenceDeleteAfter: new Date("2030-01-02T00:00:00.000Z"),
      questionIntervals: [interval(endMs)],
      recordingDurationMs: endMs,
    });

    await expect(
      persistPendingUploadFinalization(connection.db, queue, input(120_001)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(queued).toBe(0);

    const accepted = input(2_000);
    await expect(
      persistPendingUploadFinalization(connection.db, queue, accepted),
    ).resolves.toEqual({ replay: false });
    await expect(
      persistPendingUploadFinalization(connection.db, queue, accepted),
    ).resolves.toEqual({ replay: true });
    await expect(
      persistPendingUploadFinalization(connection.db, queue, {
        ...accepted,
        questionIntervals: [{ ...interval(2_000), endMs: 1_999 }],
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_FINALIZATION_CONFLICT" });
    const stored = await connection.pool.query<{
      count: number;
      intervals: unknown;
    }>(
      `SELECT count(*) OVER ()::int AS count, intervals
         FROM proof_question_interval_sets WHERE attempt_id = $1`,
      [ids.attempt],
    );
    expect(stored.rows[0]).toMatchObject({
      count: 1,
      intervals: accepted.questionIntervals,
    });
    expect(queued).toBe(1);
  });

  it("rejects interval finalization when required questions do not fill the frozen budget", async () => {
    const questionId = "20000000-0000-4000-8000-000000000037";
    const uploadSession = "20000000-0000-4000-8000-000000000038";
    const objectId = "20000000-0000-4000-8000-000000000039";
    const digest = "7".repeat(64);
    const interval = {
      schemaVersion: "1",
      intervalVersion: "proof-question-interval-v1",
      questionId,
      ordinal: 0,
      startMs: 0,
      endMs: 2_000,
      recordedDurationMs: 2_000,
      source: "mobile_navigation_v1",
    } as const;
    await connection.pool.query(
      "UPDATE proof_plans SET question_budget = 2 WHERE id = $1",
      [ids.plan],
    );
    await connection.pool.query(
      `INSERT INTO proof_questions
        (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
       VALUES ($1, $2, 0, 'explain', 'Only one required question.', '{}', '{}', true)`,
      [questionId, ids.plan],
    );
    await insertAttempt(connection, ids.attempt, "processing");
    await connection.pool.query(
      `INSERT INTO upload_sessions
        (id, attempt_id, object_id, object_key, provider_upload_id, state,
         expires_at, manifest_digest, finalize_envelope)
       VALUES ($1, $2, $3, 'evidence/incomplete-plan.enc', 'provider-incomplete',
               'pending_finalization', '2030-01-01T00:00:00.000Z', $4,
               $5::jsonb)`,
      [
        uploadSession,
        ids.attempt,
        objectId,
        digest,
        JSON.stringify({
          manifest: { durationMs: 2_000, questionIntervals: [interval] },
        }),
      ],
    );

    await expect(
      connection.pool.query(
        `INSERT INTO proof_question_interval_sets
          (attempt_id, upload_session_id, manifest_digest, interval_version,
           maximum_question_duration_ms, recorded_duration_ms, intervals)
         VALUES ($1, $2, $3, 'proof-question-interval-v1', 120000, 2000,
                 $4::jsonb)`,
        [ids.attempt, uploadSession, digest, JSON.stringify([interval])],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("shortens the deletion job idempotently without mutating the accepted artifact deadline", async () => {
    const originalDeadline = new Date("2030-01-02T00:00:00.000Z");
    await insertAttempt(connection, ids.attempt, "ready");
    await connection.pool.query(
      "UPDATE attempts SET evidence_delete_after = $2 WHERE id = $1",
      [ids.attempt, originalDeadline],
    );
    const singletonKeys: string[] = [];
    const queue = {
      async send(
        _name: string,
        _payload: unknown,
        options: { singletonKey: string },
      ) {
        singletonKeys.push(options.singletonKey);
        return "20000000-0000-4000-8000-000000000040";
      },
    } as unknown as Parameters<typeof accelerateEvidenceDeletionAfterPass>[0];
    const client = await connection.pool.connect();
    try {
      await client.query("BEGIN");
      const first = await accelerateEvidenceDeletionAfterPass(
        queue,
        client,
        ids.attempt,
      );
      const replay = await accelerateEvidenceDeletionAfterPass(
        queue,
        client,
        ids.attempt,
      );
      await client.query("COMMIT");
      expect(replay.deletionJobId).toBe(first.deletionJobId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(new Set(singletonKeys).size).toBe(1);
    const persisted = await connection.pool.query<{
      count: number;
      deadline: Date;
      evidence_delete_after: Date;
    }>(
      `SELECT count(*)::int AS count, max(deletion.deadline) AS deadline,
              max(attempt.evidence_delete_after) AS evidence_delete_after
       FROM deletion_jobs deletion
       JOIN attempts attempt ON attempt.id::text = deletion.object_id
       WHERE deletion.object_class = 'attempt_evidence'
         AND deletion.object_id = $1`,
      [ids.attempt],
    );
    expect(persisted.rows[0]?.count).toBe(1);
    expect(persisted.rows[0]?.deadline.getTime()).toBeLessThan(
      originalDeadline.getTime(),
    );
    expect(persisted.rows[0]?.evidence_delete_after).toEqual(originalDeadline);
  });

  it("binds review decisions and success checks to a current passed SHA", async () => {
    await insertAttempt(connection, ids.attempt, "review_required");
    await connection.pool.query(
      `INSERT INTO review_decisions
        (attempt_id, maintainer_id, decision, reason_code, head_sha)
       VALUES ($1, 'maintainer-1', 'pass', 'rubric_met', $2)`,
      [ids.attempt, headSha],
    );
    await connection.pool.query(
      "UPDATE attempts SET status = 'passed', completed_at = now() WHERE id = $1",
      [ids.attempt],
    );
    await expect(
      connection.pool.query(
        `INSERT INTO check_runs
          (revision_id, github_check_run_id, name, status, conclusion, public_summary, details_url)
         VALUES ($1, 'check-1', 'UnderstandProof / understanding required', 'completed', 'success',
                 'passed', 'https://slopproof.test/revision')`,
        [ids.revision],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      connection.pool.query(
        "UPDATE review_decisions SET reason_code = 'changed' WHERE attempt_id = $1",
        [ids.attempt],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await connection.pool.query(
      "UPDATE pull_request_revisions SET is_current = false, invalidated_at = now() WHERE id = $1",
      [ids.revision],
    );
    await expect(
      connection.pool.query(
        `INSERT INTO review_decisions
          (attempt_id, maintainer_id, decision, reason_code, head_sha)
         VALUES ($1, 'maintainer-2', 'pass', 'late', $2)`,
        [ids.attempt, headSha],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("makes handoff consumption single-use", async () => {
    await insertAttempt(connection, ids.attempt, "ready");
    await connection.pool.query(
      `INSERT INTO auth_sessions
        (id, token_hash, actor_id, actor_role, repository_id, csrf_hash, expires_at)
       VALUES ($1, 'session-hash', 'github-user-42', 'author', $2, 'csrf-hash', now() + interval '1 hour')`,
      [ids.session, ids.repository],
    );
    await connection.pool.query(
      `INSERT INTO handoff_tokens
        (id, attempt_id, desktop_session_id, token_hash, expires_at)
       VALUES ($1, $2, $3, 'handoff-hash', now() + interval '5 minutes')`,
      [ids.handoff, ids.attempt, ids.session],
    );
    await connection.pool.query(
      "UPDATE handoff_tokens SET consumed_at = now() WHERE id = $1",
      [ids.handoff],
    );
    await expect(
      connection.pool.query(
        "UPDATE handoff_tokens SET consumed_at = now() + interval '1 second' WHERE id = $1",
        [ids.handoff],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

async function seedCore(connection: DatabaseConnection): Promise<void> {
  await connection.pool.query(
    `INSERT INTO installations
      (id, github_installation_id, account_id, account_login)
     VALUES ($1, 'installation-1', 'account-1', 'acme')`,
    [ids.installation],
  );
  await connection.pool.query(
    `INSERT INTO repositories
      (id, installation_id, github_repository_id, owner, name, default_branch)
     VALUES ($1, $2, 'repository-1', 'acme', 'cachekit', 'main')`,
    [ids.repository, ids.installation],
  );
  await connection.pool.query(
    `INSERT INTO repository_policies
      (id, repository_id, version, schema_version, policy, policy_hash, created_by, activated_at)
     VALUES ($1, $2, 1, '1', '{"decisionMode":"maintainer_review"}', $3, 'system', now())`,
    [ids.policy, ids.repository, "e".repeat(64)],
  );
  await connection.pool.query(
    `INSERT INTO pull_requests
      (id, repository_id, github_pull_request_id, number, author_id, state)
     VALUES ($1, $2, 'pull-1', 184, 'github-user-42', 'open')`,
    [ids.pullRequest, ids.repository],
  );
  await connection.pool.query(
    `INSERT INTO pull_request_revisions
      (id, pull_request_id, head_sha, base_sha, is_current)
     VALUES ($1, $2, $3, $4, true)`,
    [ids.revision, ids.pullRequest, headSha, baseSha],
  );
  await connection.pool.query(
    `INSERT INTO proof_plans
      (id, revision_id, repository_policy_id, plan_version,
       deterministic_seed, risk_explanation, question_budget, plan_hash, status)
     VALUES ($1, $2, $3, 'planner-v1', 'seed-1', '{}', 1, $4, 'ready')`,
    [ids.plan, ids.revision, ids.policy, "f".repeat(64)],
  );
}

async function insertAttempt(
  connection: DatabaseConnection,
  id: string,
  status:
    "preparing" | "ready" | "uploading" | "processing" | "review_required",
): Promise<unknown> {
  return connection.pool.query(
    `INSERT INTO attempts
      (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
       status, nonce_hash, expires_at)
     VALUES ($1, $2, $3, 'github-user-42', $4, $5, $6, $7, now() + interval '1 hour')`,
    [
      id,
      ids.repository,
      ids.revision,
      ids.plan,
      headSha,
      status,
      "1".repeat(64),
    ],
  );
}
