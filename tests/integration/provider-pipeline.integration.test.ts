import { createHash } from "node:crypto";
import { analyzePullRequestPatch } from "@understandproof/analysis";
import {
  connectDatabase,
  EvaluationApplyPolicyJobSchema,
  migrateDatabase,
  type DatabaseConnection,
} from "@understandproof/db";
import { DEFAULT_REPOSITORY_POLICY_V1 } from "@understandproof/policy";
import {
  RECORDING_CODEC,
  buildChunkNonce,
  encodeBase64Url,
} from "../../packages/media/src/index";
import {
  FrameSelectionMetadataV1Schema,
  LocalFakeMultimodalJudgeProvider,
  LocalFakeTranscriptionProvider,
  PayloadCipher,
  ProofEvaluationV1Schema,
  TranscriptV1Schema,
} from "../../packages/providers/src/index";
import { planProof, type ProofPlan } from "@understandproof/questions";
import type {
  ProviderPipelineDispatcher,
  ProviderPipelineJobName,
  ProviderPipelineJobPayload,
} from "../../apps/worker/src/provider-pipeline-contracts";
import { PostgresProviderPipelineRepository } from "../../apps/worker/src/provider-pipeline-repository";
import type {
  CheckIntentWriter,
  WorkerCheckIntentWriterInput,
} from "../../apps/worker/src/revision-preparation";
import {
  createProviderPipelineHandlers,
  decryptVersionedProviderPayload,
  type ProviderFrameSelectionAdapter,
} from "../../apps/worker/src/provider-pipeline";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PoolClient } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const ids = {
  installation: "80000000-0000-4000-8000-000000000001",
  repository: "80000000-0000-4000-8000-000000000002",
  policy: "80000000-0000-4000-8000-000000000003",
  pullRequest: "80000000-0000-4000-8000-000000000004",
  revision: "80000000-0000-4000-8000-000000000005",
  attempt: "80000000-0000-4000-8000-000000000006",
  wrappingMaterial: "80000000-0000-4000-8000-000000000007",
  recordingObject: "80000000-0000-4000-8000-000000000008",
  wrappedObject: "80000000-0000-4000-8000-000000000009",
  checkRun: "80000000-0000-4000-8000-000000000010",
  frame: "80000000-0000-4000-8000-000000000011",
  frameDerivative: "80000000-0000-4000-8000-000000000012",
  uploadSession: "80000000-0000-4000-8000-000000000013",
  recoveryEvaluation: "80000000-0000-4000-8000-000000000014",
} as const;

const headSha = "8".repeat(40);
const baseSha = "9".repeat(40);
const clockTime = new Date("2030-08-12T12:00:00.000Z");
const recordingDurationMs = 60_000;

databaseDescribe("provider pipeline PostgreSQL persistence", () => {
  let database: DatabaseConnection;
  let proofPlan: ProofPlan;

  beforeAll(async () => {
    database = connectDatabase(databaseUrl!);
    await migrateDatabase(database.pool);
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  beforeEach(async () => {
    await database.pool.query(`
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
    proofPlan = await seedProviderAttempt(database);
  });

  it("persists all four stages encrypted, preserves planner shapes, and stops at review_required", async () => {
    const storedQuestions = await database.pool.query<{
      id: string;
      ordinal: number;
      diff_anchor: unknown;
      rubric: unknown;
    }>(
      `SELECT id, ordinal, diff_anchor, rubric
         FROM proof_questions
        WHERE proof_plan_id = $1
        ORDER BY ordinal`,
      [proofPlan.id],
    );
    expect(storedQuestions.rows).toHaveLength(proofPlan.questions.length);
    for (const [index, stored] of storedQuestions.rows.entries()) {
      const planned = proofPlan.questions[index];
      expect(planned).toBeDefined();
      expect(stored).toEqual({
        id: planned!.id,
        ordinal: index,
        diff_anchor: planned!.anchor,
        rubric: planned!.rubric,
      });
    }

    const dispatcher = new RecordingDispatcher();
    const clock = { now: () => new Date(clockTime) };
    let nonce = 0;
    const cipher = new PayloadCipher(Buffer.alloc(32, 0x5a), (length) => {
      nonce += 1;
      return Buffer.alloc(length, nonce);
    });
    const checkIntents = new RecordingCheckIntentWriter();
    const repository = new PostgresProviderPipelineRepository(
      database,
      checkIntents,
    );
    const handlers = createProviderPipelineHandlers({
      repository,
      dispatcher,
      payloadCipher: cipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider(clock),
      frameSelectionAdapter: new OneFrameSelectionAdapter(),
      judgeProvider: new LocalFakeMultimodalJudgeProvider(clock),
      clock,
    });
    const checkBefore = await loadCheckRun(database);

    const extraction = await handlers.extractTranscript({
      schemaVersion: "1",
      idempotencyKey: "provider-integration:extract",
      attemptId: ids.attempt,
      recordingObjectId: ids.recordingObject,
      expectedHeadSha: headSha,
    });
    expect(extraction).toMatchObject({
      stage: "media.extract-transcript",
      outcome: "completed",
      attemptId: ids.attempt,
    });
    const transcriptId = requiredArtifactId(extraction.artifactId);

    const transcriptRows = await database.pool.query<{
      id: string;
      encrypted_payload: string;
      schema_version: string;
    }>(
      `SELECT id, encrypted_payload, schema_version
         FROM transcripts WHERE attempt_id = $1`,
      [ids.attempt],
    );
    expect(transcriptRows.rows).toHaveLength(1);
    const transcriptRow = transcriptRows.rows[0]!;
    expect(transcriptRow.schema_version).toBe("transcript-v1");
    expect(transcriptRow.encrypted_payload).not.toContain("requiredPoints");
    expect(transcriptRow.encrypted_payload).not.toContain("authorization.ts");
    const transcript = decryptVersionedProviderPayload(
      cipher,
      transcriptRow.encrypted_payload,
      `slopproof:transcript:v1:${ids.attempt}:${transcriptId}`,
      TranscriptV1Schema,
    );
    expect(transcript.id).toBe(transcriptId);
    expect(transcript.segments.map((segment) => segment.questionId)).toEqual(
      proofPlan.questions.map((question) => question.id),
    );
    expect(transcript.segments[0]?.text.content).toContain(
      proofPlan.questions[0]!.rubric.requiredPoints[0],
    );

    const extractionReplay = await handlers.extractTranscript({
      schemaVersion: "1",
      idempotencyKey: "provider-integration:extract",
      attemptId: ids.attempt,
      recordingObjectId: ids.recordingObject,
      expectedHeadSha: headSha,
    });
    expect(extractionReplay.outcome).toBe("replayed");
    await expect(rowCount(database, "transcripts")).resolves.toBe(1);

    const frameSelectionJob = dispatcher.first("media.select-frames");
    const frameSelection = await handlers.selectFrames(frameSelectionJob);
    expect(frameSelection).toMatchObject({
      stage: "media.select-frames",
      outcome: "completed",
      attemptId: ids.attempt,
    });
    const frameRows = await database.pool.query<{
      id: string;
      object_key: string;
      timestamp_ms: number;
    }>(
      `SELECT id, object_key, timestamp_ms
         FROM frame_selections WHERE attempt_id = $1`,
      [ids.attempt],
    );
    expect(frameRows.rows).toEqual([
      {
        id: ids.frame,
        object_key: `provider-frame/${ids.frameDerivative}/${"a".repeat(64)}/1280x720`,
        timestamp_ms: 30_000,
      },
    ]);

    const evaluationJob = dispatcher.first("evaluation.run");
    const evaluationRun = await handlers.runEvaluation(evaluationJob);
    expect(evaluationRun).toMatchObject({
      stage: "evaluation.run",
      outcome: "completed",
      attemptId: ids.attempt,
    });
    const evaluationId = requiredArtifactId(evaluationRun.artifactId);
    const evaluationRows = await database.pool.query<{
      id: string;
      recommendation: string;
      encrypted_payload: string;
    }>(
      `SELECT id, recommendation, encrypted_payload
         FROM evaluations WHERE attempt_id = $1`,
      [ids.attempt],
    );
    expect(evaluationRows.rows).toHaveLength(1);
    const evaluationRow = evaluationRows.rows[0]!;
    expect(evaluationRow).toMatchObject({
      id: evaluationId,
      recommendation: "pass",
    });
    expect(evaluationRow.encrypted_payload).not.toContain(
      "questionEvaluations",
    );
    expect(evaluationRow.encrypted_payload).not.toContain(
      proofPlan.questions[0]!.id,
    );
    const evaluation = decryptVersionedProviderPayload(
      cipher,
      evaluationRow.encrypted_payload,
      `slopproof:evaluation:v1:${ids.attempt}:${evaluationId}`,
      ProofEvaluationV1Schema,
    );
    expect(evaluation.recommendation).toBe("pass");
    expect(
      evaluation.questionEvaluations.map((item) => item.questionId),
    ).toEqual(proofPlan.questions.map((question) => question.id));
    expect(
      evaluation.questionEvaluations.flatMap((item) => item.rubricFindings),
    ).toSatisfy((findings: Array<{ result: string }>) =>
      findings.every((finding) => finding.result === "met"),
    );

    const evaluationReplay = await handlers.runEvaluation(evaluationJob);
    expect(evaluationReplay.outcome).toBe("replayed");
    await expect(rowCount(database, "evaluations")).resolves.toBe(1);

    const policyJob = EvaluationApplyPolicyJobSchema.parse(
      dispatcher.first("evaluation.apply-policy"),
    );
    await database.pool.query(
      `INSERT INTO repository_policies
        (repository_id, version, schema_version, policy, policy_hash,
         created_by, activated_at)
       VALUES ($1, 2, '1', $2::jsonb, $3, 'maintainer', now())`,
      [
        ids.repository,
        JSON.stringify({
          ...DEFAULT_REPOSITORY_POLICY_V1,
          evidence: {
            retentionHours: 12,
            deleteAfterMaintainerPass: false,
          },
        }),
        "6".repeat(64),
      ],
    );
    await database.pool.query(
      "UPDATE repositories SET active_policy_version = 2 WHERE id = $1",
      [ids.repository],
    );
    const frozenPolicyContext =
      await repository.loadEvaluationPolicy(policyJob);
    expect(frozenPolicyContext.repositoryPolicy).toEqual(
      DEFAULT_REPOSITORY_POLICY_V1,
    );
    const policy = await handlers.applyPolicy(policyJob);
    expect(policy).toMatchObject({
      stage: "evaluation.apply-policy",
      outcome: "completed",
      attemptId: ids.attempt,
      artifactId: evaluationId,
    });
    const policyReplay = await handlers.applyPolicy(policyJob);
    expect(policyReplay.outcome).toBe("replayed");

    const attempt = await database.pool.query<{ status: string }>(
      "SELECT status FROM attempts WHERE id = $1",
      [ids.attempt],
    );
    expect(attempt.rows[0]?.status).toBe("review_required");
    const transitions = await database.pool.query<{
      from_status: string;
      to_status: string;
      actor_id: string;
      actor_role: string;
    }>(
      `SELECT from_status, to_status, actor_id, actor_role
         FROM attempt_transitions WHERE attempt_id = $1`,
      [ids.attempt],
    );
    expect(transitions.rows).toEqual([
      {
        from_status: "processing",
        to_status: "review_required",
        actor_id: "provider-pipeline",
        actor_role: "system",
      },
    ]);
    const audit = await database.pool.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM audit_events
        WHERE object_type = 'attempt' AND object_id = $1`,
      [ids.attempt],
    );
    expect(audit.rows).toEqual([
      {
        action: "attempt.review_required",
        metadata: {
          reason: "valid_policy",
          evaluationId,
          providerRecommendation: "pass",
        },
      },
    ]);

    expect(dispatcher.names()).toEqual([
      "media.select-frames",
      "media.select-frames",
      "evaluation.run",
      "evaluation.apply-policy",
      "evaluation.apply-policy",
    ]);
    expect(dispatcher.names()).not.toContain("github.reconcile-check");
    expect(checkIntents.calls).toEqual([
      {
        revisionId: ids.revision,
        headSha,
        status: "in_progress",
        conclusion: null,
        summary: `maintainer review required for head ${headSha}`,
        reason: "review_required",
        idempotencyKey: `provider-pipeline:policy-review:${createHash("sha256")
          .update(policyJob.idempotencyKey)
          .digest("hex")
          .slice(0, 48)}`,
      },
    ]);
    expect(await loadCheckRun(database)).toEqual(checkBefore);
  });

  it("loads the exact authenticated interval source for worker-only production transcription", async () => {
    const intervals = proofPlan.questions.map((question, index, questions) => {
      const startMs = Math.floor(
        (recordingDurationMs * index) / questions.length,
      );
      const endMs = Math.floor(
        (recordingDurationMs * (index + 1)) / questions.length,
      );
      return {
        schemaVersion: "1" as const,
        intervalVersion: "proof-question-interval-v1" as const,
        questionId: question.id,
        ordinal: index,
        startMs,
        endMs,
        recordedDurationMs: recordingDurationMs,
        source: "mobile_navigation_v1" as const,
      };
    });
    const noncePrefix = new Uint8Array(8);
    const finalization = {
      manifest: {
        protocolVersion: 1 as const,
        suiteId: "SP-RC1" as const,
        attemptId: ids.attempt,
        headSha,
        objectId: ids.wrappedObject,
        codec: RECORDING_CODEC,
        noncePrefixBase64url: encodeBase64Url(noncePrefix),
        wrapping: {
          materialId: ids.wrappingMaterial,
          keyId: "provider-integration-key",
          algorithm: "RSA-OAEP-256" as const,
          wrappedKeySha256: "4".repeat(64),
        },
        durationMs: recordingDurationMs,
        totalPlaintextBytes: 1,
        totalObjectBytes: 49,
        questionIntervals: intervals,
        chunks: [
          {
            index: 0,
            nonce: encodeBase64Url(buildChunkNonce(noncePrefix, 0)),
            plaintextBytes: 1,
            sealedBytes: 17,
            ciphertextSha256: "a".repeat(64),
          },
        ],
        parts: [
          {
            partNumber: 1,
            firstChunkIndex: 0,
            lastChunkIndex: 0,
            byteLength: 49,
            sha256: "b".repeat(64),
          },
        ],
      },
      manifestTagBase64url: encodeBase64Url(new Uint8Array(32)),
      manifestDigest: "5".repeat(64),
      wrappedKey: {
        materialId: ids.wrappingMaterial,
        keyId: "provider-integration-key",
        algorithm: "RSA-OAEP-256" as const,
        wrappedKeyBase64url: encodeBase64Url(new Uint8Array([1])),
        wrappedKeySha256: "4".repeat(64),
      },
      uploadedParts: [{ partNumber: 1, etag: "private-etag" }],
    };
    await database.pool.query(
      `UPDATE recording_objects
          SET byte_length = 49, codec = $2
        WHERE id = $1`,
      [ids.recordingObject, RECORDING_CODEC],
    );
    await database.pool.query(
      `INSERT INTO upload_sessions
        (id, attempt_id, object_id, object_key, provider_upload_id, state,
         expires_at, manifest_digest, finalize_envelope)
       VALUES ($1, $2, $3, 'evidence/provider-integration.enc',
               'provider-production-source', 'pending_finalization',
               '2030-08-14T12:00:00.000Z', $4, $5::jsonb)`,
      [
        ids.uploadSession,
        ids.attempt,
        ids.wrappedObject,
        finalization.manifestDigest,
        JSON.stringify(finalization),
      ],
    );
    await database.pool.query(
      `INSERT INTO proof_question_interval_sets
        (attempt_id, upload_session_id, manifest_digest, interval_version,
         maximum_question_duration_ms, recorded_duration_ms, intervals)
       VALUES ($1, $2, $3, 'proof-question-interval-v1', 120000, $4, $5::jsonb)`,
      [
        ids.attempt,
        ids.uploadSession,
        finalization.manifestDigest,
        recordingDurationMs,
        JSON.stringify(intervals),
      ],
    );
    await database.pool.query(
      "UPDATE upload_sessions SET state = 'completed' WHERE id = $1",
      [ids.uploadSession],
    );
    const repository = new PostgresProviderPipelineRepository(
      database,
      new RecordingCheckIntentWriter(),
    );

    const context = await repository.loadTranscriptExtraction({
      schemaVersion: "1",
      idempotencyKey: "provider-integration:production-source",
      attemptId: ids.attempt,
      recordingObjectId: ids.recordingObject,
      expectedHeadSha: headSha,
    });

    expect(context.recordingAudio).toEqual({
      objectKey: "evidence/provider-integration.enc",
      source: expect.objectContaining({
        attemptId: ids.attempt,
        recordingObjectId: ids.recordingObject,
        sourceSha256: finalization.manifestDigest,
        proofQuestionIds: proofPlan.questions.map((question) => question.id),
        questionIntervals: intervals,
        finalization,
      }),
    });
  });

  it("rebuilds an exhausted provider stage from the exact committed evaluation ID", async () => {
    await database.pool.query(
      `INSERT INTO evaluations
        (id, attempt_id, provider, model, prompt_version, schema_version,
         rubric_version, encrypted_payload, recommendation, delete_after)
       VALUES ($1, $2, 'recovery-provider', 'recovery-model',
               'proof-judge-system-v1', 'proof-evaluation-v1', 'rubric-v1',
               'encrypted-recovery-payload', 'pass', $3)`,
      [
        ids.recoveryEvaluation,
        ids.attempt,
        new Date("2030-08-13T12:00:00.000Z"),
      ],
    );
    const queue = {
      findJobs: vi.fn(async () => []),
      upsert: vi.fn(async () => ({ jobs: ["recovery-job"] })),
    };
    const repository = new PostgresProviderPipelineRepository(
      database,
      new RecordingCheckIntentWriter(),
      queue as never,
    );

    await expect(repository.sweepPendingProviderStages()).resolves.toBe(1);

    expect(queue.upsert).toHaveBeenCalledWith(
      "evaluation.apply-policy",
      expect.objectContaining({
        attemptId: ids.attempt,
        evaluationId: ids.recoveryEvaluation,
        expectedHeadSha: headSha,
      }),
      expect.objectContaining({
        singletonKey: ids.attempt,
        db: expect.any(Object),
      }),
    );
  });

  it("fences a valid-policy transition when evidence retention has expired", async () => {
    await database.pool.query(
      `INSERT INTO evaluations
        (id, attempt_id, provider, model, prompt_version, schema_version,
         rubric_version, encrypted_payload, recommendation, delete_after)
       VALUES ($1, $2, 'retention-provider', 'retention-model',
               'proof-judge-system-v1', 'proof-evaluation-v1', 'rubric-v1',
               'encrypted-retention-payload', 'pass', $3)`,
      [
        ids.recoveryEvaluation,
        ids.attempt,
        new Date("2030-08-13T12:00:00.000Z"),
      ],
    );
    await database.pool.query(
      "UPDATE evaluations SET deleted_at = now() WHERE id = $1",
      [ids.recoveryEvaluation],
    );
    const repository = new PostgresProviderPipelineRepository(
      database,
      new RecordingCheckIntentWriter(),
    );

    await expect(
      repository.transitionToReviewRequired({
        attemptId: ids.attempt,
        expectedHeadSha: headSha,
        idempotencyKey: "provider-integration:expired-policy-fence",
        evaluationId: ids.recoveryEvaluation,
        providerRecommendation: "pass",
        reason: "valid_policy",
      }),
    ).resolves.toBe("stale");
    const attempt = await database.pool.query<{ status: string }>(
      "SELECT status FROM attempts WHERE id = $1",
      [ids.attempt],
    );
    expect(attempt.rows[0]?.status).toBe("processing");
  });

  it("fails closed before transcription when retention or GitHub lifecycle access is inactive", async () => {
    const transcribe = vi.fn(async () => {
      throw new Error("transcription must not run for inactive private data");
    });
    const repository = new PostgresProviderPipelineRepository(
      database,
      new RecordingCheckIntentWriter(),
    );
    const handlers = createProviderPipelineHandlers({
      repository,
      dispatcher: new RecordingDispatcher(),
      payloadCipher: new PayloadCipher(Buffer.alloc(32, 0x2a)),
      transcriptionProvider: { transcribe },
      frameSelectionAdapter: new OneFrameSelectionAdapter(),
      judgeProvider: new LocalFakeMultimodalJudgeProvider({
        now: () => clockTime,
      }),
      clock: { now: () => clockTime },
    });
    const cases = [
      {
        disable:
          "UPDATE repositories SET status = 'suspended', suspended_at = now() WHERE id = $1",
        enable:
          "UPDATE repositories SET status = 'active', suspended_at = NULL WHERE id = $1",
        id: ids.repository,
      },
      {
        disable:
          "UPDATE installations SET status = 'suspended', suspended_at = now() WHERE id = $1",
        enable:
          "UPDATE installations SET status = 'active', suspended_at = NULL WHERE id = $1",
        id: ids.installation,
      },
      {
        disable: "UPDATE pull_requests SET state = 'closed' WHERE id = $1",
        enable: "UPDATE pull_requests SET state = 'open' WHERE id = $1",
        id: ids.pullRequest,
      },
      {
        disable:
          "UPDATE recording_objects SET deleted_at = now() WHERE id = $1",
        enable: "UPDATE recording_objects SET deleted_at = NULL WHERE id = $1",
        id: ids.recordingObject,
      },
    ];

    for (const [index, lifecycle] of cases.entries()) {
      await database.pool.query(lifecycle.disable, [lifecycle.id]);
      const outcome = await handlers.extractTranscript({
        schemaVersion: "1",
        idempotencyKey: `provider-integration:inactive:${String(index)}`,
        attemptId: ids.attempt,
        recordingObjectId: ids.recordingObject,
        expectedHeadSha: headSha,
      });
      expect(outcome.outcome).toBe("stale");
      expect(transcribe).not.toHaveBeenCalled();
      await database.pool.query(lifecycle.enable, [lifecycle.id]);
    }
  });
});

class RecordingCheckIntentWriter implements CheckIntentWriter {
  readonly calls: WorkerCheckIntentWriterInput[] = [];

  async write(
    _client: PoolClient,
    input: WorkerCheckIntentWriterInput,
  ): Promise<void> {
    this.calls.push(input);
  }
}

class RecordingDispatcher implements ProviderPipelineDispatcher {
  private readonly dispatched: Array<{
    name: ProviderPipelineJobName;
    payload: ProviderPipelineJobPayload;
  }> = [];

  async enqueue(
    name: ProviderPipelineJobName,
    payload: ProviderPipelineJobPayload,
  ): Promise<void> {
    this.dispatched.push({ name, payload });
  }

  first(name: ProviderPipelineJobName): ProviderPipelineJobPayload {
    const match = this.dispatched.find((item) => item.name === name);
    if (match === undefined) throw new Error(`No ${name} job was dispatched`);
    return match.payload;
  }

  names(): string[] {
    return this.dispatched.map((item) => item.name);
  }
}

class OneFrameSelectionAdapter implements ProviderFrameSelectionAdapter {
  async select(input: { attemptId: string; recordingDurationMs: number }) {
    return FrameSelectionMetadataV1Schema.parse({
      schemaVersion: "1",
      selectionVersion: "frame-selection-v1",
      attemptId: input.attemptId,
      recordingDurationMs: input.recordingDurationMs,
      frames: [
        {
          id: ids.frame,
          timestampMs: 30_000,
          reasonCode: "answer_midpoint",
          reason:
            "A deterministic encrypted derivative for integration testing.",
          encryptedDerivativeRef: ids.frameDerivative,
          ciphertextSha256: "a".repeat(64),
          width: 1280,
          height: 720,
        },
      ],
    });
  }
}

async function seedProviderAttempt(
  database: DatabaseConnection,
): Promise<ProofPlan> {
  const analysis = analyzePullRequestPatch({
    baseSha,
    headSha,
    files: [
      {
        path: "src/authorization.ts",
        kind: "text",
        patch: [
          "@@ -10,3 +10,5 @@ export function canReview(role: string) {",
          "-  return role === 'author';",
          "+  const authorized = role === 'maintainer';",
          "+  return authorized;",
        ].join("\n"),
        additions: 2,
        deletions: 1,
      },
    ],
  });
  const proofPlan = planProof(
    {
      analysis,
      policy: DEFAULT_REPOSITORY_POLICY_V1,
      serverSeed:
        "provider-integration-proof-seed-00000000000000000000000000000000",
      versions: {
        planner: "proof-planner-v1",
        questionTemplates: "proof-questions-v1",
      },
    },
    { clock: { now: () => new Date(clockTime) } },
  );
  if (proofPlan.status !== "ready" || proofPlan.questions.length === 0) {
    throw new Error("Integration fixture did not produce a ready proof plan");
  }

  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO installations
        (id, github_installation_id, account_id, account_login)
       VALUES ($1, 'provider-integration-installation',
               'provider-integration-account', 'acme')`,
      [ids.installation],
    );
    await client.query(
      `INSERT INTO repositories
        (id, installation_id, github_repository_id, owner, name, default_branch)
       VALUES ($1, $2, 'provider-integration-repository',
               'acme', 'provider-integration', 'main')`,
      [ids.repository, ids.installation],
    );
    await client.query(
      `INSERT INTO repository_policies
        (id, repository_id, version, schema_version, policy, policy_hash,
         created_by, activated_at)
       VALUES ($1, $2, 1, '1', $3::jsonb, $4, 'system', now())`,
      [
        ids.policy,
        ids.repository,
        JSON.stringify(DEFAULT_REPOSITORY_POLICY_V1),
        "1".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO pull_requests
        (id, repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, 'provider-integration-pr', 801,
               'provider-integration-author', 'open')`,
      [ids.pullRequest, ids.repository],
    );
    await client.query(
      `INSERT INTO pull_request_revisions
        (id, pull_request_id, head_sha, base_sha, is_current)
       VALUES ($1, $2, $3, $4, true)`,
      [ids.revision, ids.pullRequest, headSha, baseSha],
    );
    await client.query(
      `INSERT INTO proof_plans
        (id, revision_id, repository_policy_id, plan_version,
         deterministic_seed, risk_explanation, question_budget, plan_hash,
         status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
      [
        proofPlan.id,
        ids.revision,
        ids.policy,
        proofPlan.plannerVersion,
        proofPlan.seedCommitment,
        JSON.stringify({
          riskLevel: proofPlan.riskLevel,
          riskVector: proofPlan.riskVector,
          rationale: proofPlan.rationale,
        }),
        proofPlan.questionBudget,
        proofPlan.planHash,
        proofPlan.status,
        proofPlan.createdAt,
      ],
    );
    for (const [ordinal, question] of proofPlan.questions.entries()) {
      await client.query(
        `INSERT INTO proof_questions
          (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, true)`,
        [
          question.id,
          proofPlan.id,
          ordinal,
          question.intent,
          question.prompt,
          JSON.stringify(question.anchor),
          JSON.stringify(question.rubric),
        ],
      );
    }
    await client.query(
      `INSERT INTO attempts
        (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
         status, nonce_hash, expires_at, started_at, evidence_delete_after)
       VALUES ($1, $2, $3, 'provider-integration-author', $4, $5,
               'processing', $6, $7, now(), $8)`,
      [
        ids.attempt,
        ids.repository,
        ids.revision,
        proofPlan.id,
        headSha,
        "2".repeat(64),
        new Date("2030-08-14T12:00:00.000Z"),
        new Date("2030-08-13T12:00:00.000Z"),
      ],
    );
    await client.query(
      `INSERT INTO wrapping_materials
        (id, attempt_id, object_id, key_id, algorithm, spki_sha256, usable_until)
       VALUES ($1, $2, $3, 'provider-integration-key', 'RSA-OAEP-256', $4, $5)`,
      [
        ids.wrappingMaterial,
        ids.attempt,
        ids.wrappedObject,
        "3".repeat(64),
        new Date("2030-08-14T12:00:00.000Z"),
      ],
    );
    await client.query(
      `INSERT INTO recording_objects
        (id, attempt_id, object_key, wrapped_data_key, wrapped_key_sha256,
         wrapping_material_id, protocol_version, algorithm, byte_length,
         duration_ms, codec, manifest_hash, delete_after)
       VALUES ($1, $2, 'evidence/provider-integration.enc',
               'provider-integration-wrapped-data-key', $3, $4,
               'SP-RC1', 'AES-256-GCM', 4096, $5,
               'video/webm;codecs=vp9,opus', $6, $7)`,
      [
        ids.recordingObject,
        ids.attempt,
        "4".repeat(64),
        ids.wrappingMaterial,
        recordingDurationMs,
        "5".repeat(64),
        new Date("2030-08-13T12:00:00.000Z"),
      ],
    );
    await client.query(
      `INSERT INTO check_runs
        (id, revision_id, github_check_run_id, name, status, conclusion,
         public_summary, details_url, last_synchronized_at, created_at, updated_at)
       VALUES ($1, $2, 'provider-integration-check',
               'UnderstandProof / understanding required', 'in_progress', NULL,
               'Proof processing is in progress.',
               'https://slopproof.test/provider-integration', $3, $3, $3)`,
      [ids.checkRun, ids.revision, new Date("2030-08-12T11:00:00.000Z")],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return proofPlan;
}

async function loadCheckRun(database: DatabaseConnection) {
  const result = await database.pool.query<{
    status: string;
    conclusion: string | null;
    public_summary: string;
    last_synchronized_at: Date;
    updated_at: Date;
  }>(
    `SELECT status, conclusion, public_summary, last_synchronized_at, updated_at
       FROM check_runs WHERE id = $1`,
    [ids.checkRun],
  );
  return result.rows[0];
}

async function rowCount(
  database: DatabaseConnection,
  table: "transcripts" | "evaluations",
): Promise<number> {
  const result = await database.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return result.rows[0]?.count ?? 0;
}

function requiredArtifactId(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Pipeline result omitted artifact ID");
  return value;
}
