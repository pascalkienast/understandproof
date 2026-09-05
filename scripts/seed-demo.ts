import { createHash } from "node:crypto";
import {
  analyzePullRequestPatch,
  boundedRevisionSourcePatch,
  buildBoundedRevisionSourceV1,
  buildGenerationContextV1,
  type GithubRevisionSourceV1,
  type PullRequestPatch,
} from "@understandproof/analysis";
import {
  connectDatabase,
  persistGithubRevisionSourceInTransaction,
} from "@understandproof/db";
import { DEFAULT_REPOSITORY_POLICY_V1 } from "@understandproof/policy";
import { planProof } from "@understandproof/questions";
import { persistGenerationContextV1InTransaction } from "../apps/worker/src/generation-context-repository";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = connectDatabase(databaseUrl);
const installationId = "50000000-0000-4000-8000-000000000001";
const repositoryId = "50000000-0000-4000-8000-000000000002";
const githubInstallationId = "500001";
const githubAccountId = "500002";
const githubRepositoryId = "500003";
const githubAuthorId = "500004";
const baseSha = "1".repeat(40);

const seeds: readonly {
  number: number;
  pullRequestId: string;
  revisionId: string;
  attemptId: string;
  title: string;
  patch: PullRequestPatch;
}[] = [
  {
    number: 184,
    pullRequestId: "51000000-0000-4000-8000-000000000001",
    revisionId: "52000000-0000-4000-8000-000000000001",
    attemptId: "53000000-0000-4000-8000-000000000001",
    title: "Fix checkout rounding",
    patch: patch("2", [
      {
        path: "src/money/round-total.ts",
        additions: 1,
        deletions: 1,
        patch:
          "@@ -8,1 +8,1 @@ export function roundTotal(value: number)\n-  return Math.floor(value * 100) / 100;\n+  return Math.round(value * 100) / 100;",
      },
    ]),
  },
  {
    number: 185,
    pullRequestId: "51000000-0000-4000-8000-000000000002",
    revisionId: "52000000-0000-4000-8000-000000000002",
    attemptId: "53000000-0000-4000-8000-000000000002",
    title: "Publish normalized order events",
    patch: patch("3", [
      {
        path: "apps/web/orders/route.ts",
        additions: 3,
        deletions: 1,
        patch:
          "@@ -14,2 +14,4 @@ export async function POST(request: Request)\n-  return service.create(await request.json());\n+  const command = await request.json();\n+  const order = await service.create(command);\n+  return Response.json(order, { status: 201 });",
      },
      {
        path: "packages/orders/service.ts",
        additions: 3,
        deletions: 1,
        patch:
          "@@ -20,2 +20,4 @@ export async function create(command: Command)\n-  return repository.insert(command);\n+  const normalized = normalize(command);\n+  await events.publish('order.requested');\n+  return repository.insert(normalized);",
      },
      {
        path: "packages/orders/service.test.ts",
        additions: 2,
        deletions: 0,
        patch:
          "@@ -30,0 +31,2 @@ describe('create')\n+  expect(await create(fixture)).toEqual(expected);\n+  expect(events.publish).toHaveBeenCalled();",
      },
    ]),
  },
  {
    number: 186,
    pullRequestId: "51000000-0000-4000-8000-000000000003",
    revisionId: "52000000-0000-4000-8000-000000000003",
    attemptId: "53000000-0000-4000-8000-000000000003",
    title: "Scope sessions during migration",
    patch: patch("4", [
      {
        path: "apps/web/auth/session.ts",
        additions: 4,
        deletions: 1,
        patch:
          "@@ -11,2 +11,5 @@ export async function authenticate(token: string)\n-  return sessions.find(token);\n+  return database.transaction(async (transaction) => {\n+    const session = await transaction.lockSession(token);\n+    return authorize(session, 'proof:start');\n+  });",
      },
      {
        path: "packages/db/migrations/0042_session_scope.sql",
        additions: 2,
        deletions: 0,
        patch:
          "@@ -0,0 +1,2 @@\n+ALTER TABLE auth_sessions ADD COLUMN scope text;\n+CREATE INDEX auth_sessions_scope_idx ON auth_sessions(scope);",
      },
      {
        path: "apps/web/auth/session.test.ts",
        additions: 2,
        deletions: 0,
        patch:
          "@@ -20,0 +21,2 @@ describe('authenticate')\n+  it('rejects a session without the required scope', async () => {\n+    await expect(authenticate(token)).rejects.toThrow();",
      },
    ]),
  },
];

const client = await database.pool.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO github_app_account_allowlist (github_account_id, status)
     VALUES ($1, 'active')
     ON CONFLICT (github_account_id) DO UPDATE SET
       status = 'active',
       updated_at = now()`,
    [githubAccountId],
  );
  const installation = await client.query<{ id: string }>(
    `INSERT INTO installations
      (id, github_installation_id, account_id, account_login)
     VALUES ($1, $2, $3, 'acme')
     ON CONFLICT (id) DO UPDATE SET
       github_installation_id = EXCLUDED.github_installation_id,
       account_id = EXCLUDED.account_id,
       account_login = EXCLUDED.account_login,
       updated_at = now()
     RETURNING id`,
    [installationId, githubInstallationId, githubAccountId],
  );
  const activeInstallationId = installation.rows[0]!.id;
  const repository = await client.query<{ id: string }>(
    `INSERT INTO repositories
      (id, installation_id, github_repository_id, owner, name, default_branch)
     VALUES ($1, $2, $3, 'acme', 'cachekit', 'main')
     ON CONFLICT (owner, name) DO UPDATE SET
       installation_id = EXCLUDED.installation_id,
       github_repository_id = EXCLUDED.github_repository_id,
       default_branch = EXCLUDED.default_branch,
       updated_at = now()
     RETURNING id`,
    [repositoryId, activeInstallationId, githubRepositoryId],
  );
  const activeRepositoryId = repository.rows[0]!.id;
  const policyJson = JSON.stringify(DEFAULT_REPOSITORY_POLICY_V1);
  const policyHash = sha256(policyJson);
  await client.query(
    `INSERT INTO repository_policies
      (repository_id, version, schema_version, policy, policy_hash,
       created_by, activated_at)
     SELECT $1, COALESCE(max(version), 0) + 1, '1', $2::jsonb, $3,
            'demo-seed', now()
       FROM repository_policies
      WHERE repository_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM repository_policies
           WHERE repository_id = $1 AND policy_hash = $3
        )
     ON CONFLICT (repository_id, policy_hash) DO NOTHING`,
    [activeRepositoryId, policyJson, policyHash],
  );
  const activePolicy = await client.query<{ id: string; version: number }>(
    `SELECT id, version FROM repository_policies
     WHERE repository_id = $1 AND policy_hash = $2`,
    [activeRepositoryId, policyHash],
  );
  const activePolicyId = activePolicy.rows[0]?.id;
  if (!activePolicyId) throw new Error("Demo repository policy is missing");
  await client.query(
    `UPDATE repositories SET active_policy_version = $2, updated_at = now()
     WHERE id = $1`,
    [activeRepositoryId, activePolicy.rows[0]!.version],
  );

  for (const seed of seeds) {
    const githubPullRequestId = String(510_000 + seed.number);
    const source = githubSource(seed, githubPullRequestId);
    const boundedSource = buildBoundedRevisionSourceV1(source);
    const boundedPatch = boundedRevisionSourcePatch(boundedSource);
    const analysis = analyzePullRequestPatch(boundedPatch);
    const proof = planProof(
      {
        analysis,
        policy: DEFAULT_REPOSITORY_POLICY_V1,
        serverSeed: `demo-proof-seed-${String(seed.number)}-${"x".repeat(32)}`,
        versions: {
          planner: "proof-planner-v1",
          questionTemplates: "proof-questions-v1",
        },
      },
      { clock: { now: () => new Date("2026-08-11T12:00:00.000Z") } },
    );
    const pullRequest = await client.query<{ id: string }>(
      `INSERT INTO pull_requests
        (id, repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, $3, $4, $5, 'open')
       ON CONFLICT (repository_id, number) DO UPDATE SET
         github_pull_request_id = EXCLUDED.github_pull_request_id,
         author_id = EXCLUDED.author_id,
         state = EXCLUDED.state,
         updated_at = now()
       RETURNING id`,
      [
        seed.pullRequestId,
        activeRepositoryId,
        githubPullRequestId,
        seed.number,
        githubAuthorId,
      ],
    );
    const activePullRequestId = pullRequest.rows[0]!.id;
    await client.query(
      `UPDATE pull_request_revisions
       SET is_current = false, invalidated_at = COALESCE(invalidated_at, now())
       WHERE pull_request_id = $1 AND head_sha <> $2 AND is_current = true`,
      [activePullRequestId, seed.patch.headSha],
    );
    const revision = await client.query<{ id: string }>(
      `INSERT INTO pull_request_revisions
        (id, pull_request_id, head_sha, base_sha, is_current)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (pull_request_id, head_sha, base_sha) DO UPDATE SET
         is_current = true,
         invalidated_at = NULL
       RETURNING id`,
      [
        seed.revisionId,
        activePullRequestId,
        seed.patch.headSha,
        seed.patch.baseSha,
      ],
    );
    const activeRevisionId = revision.rows[0]!.id;
    const persistedSource = await persistGithubRevisionSourceInTransaction(
      client,
      {
        revisionId: activeRevisionId,
        fetchedAt: new Date("2026-08-11T12:00:00.000Z"),
        source,
      },
    );
    if (persistedSource.sourceHash !== boundedSource.sourceHash) {
      throw new Error("Demo revision source hash mismatch");
    }
    const insertedAnalysis = await client.query<{ id: string }>(
      `INSERT INTO analysis_snapshots
        (revision_id, analyzer_version, diff_hash, snapshot, status)
       VALUES ($1, $2, $3, $4::jsonb, 'ready')
       ON CONFLICT (revision_id, analyzer_version, diff_hash) DO NOTHING
       RETURNING id`,
      [
        activeRevisionId,
        analysis.analyzerVersion,
        sha256(JSON.stringify(boundedPatch)),
        JSON.stringify(analysis),
      ],
    );
    const analysisSnapshotId =
      insertedAnalysis.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `SELECT id FROM analysis_snapshots
            WHERE revision_id = $1 AND analyzer_version = $2 AND diff_hash = $3
            FOR SHARE`,
          [
            activeRevisionId,
            analysis.analyzerVersion,
            sha256(JSON.stringify(boundedPatch)),
          ],
        )
      ).rows[0]?.id;
    if (!analysisSnapshotId)
      throw new Error("Demo analysis snapshot is missing");
    const persistedGenerationContext =
      await persistGenerationContextV1InTransaction(
        client,
        buildGenerationContextV1({
          revisionId: activeRevisionId,
          analysisSnapshotId,
          boundedSource,
          analysis,
        }),
      );
    await client.query(
      `INSERT INTO semantic_generation_budgets
        (generation_context_id, repository_id, revision_id,
         repository_policy_id, head_sha, question_budget, budget_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'semantic-generation-budget-v1')
       ON CONFLICT (generation_context_id) DO NOTHING`,
      [
        persistedGenerationContext.id,
        activeRepositoryId,
        activeRevisionId,
        activePolicyId,
        seed.patch.headSha,
        proof.questionBudget,
      ],
    );
    await client.query(
      `INSERT INTO proof_plans
        (id, revision_id, generation_context_id, repository_policy_id, plan_version,
         deterministic_seed, risk_explanation, question_budget, plan_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'ready')
       ON CONFLICT (revision_id, plan_hash) DO NOTHING`,
      [
        proof.id,
        activeRevisionId,
        persistedGenerationContext.id,
        activePolicyId,
        proof.plannerVersion,
        proof.seedCommitment,
        JSON.stringify({
          title: seed.title,
          riskLevel: proof.riskLevel,
          rationale: proof.rationale,
        }),
        proof.questionBudget,
        proof.planHash,
      ],
    );
    for (const question of proof.questions) {
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
    await client.query(
      `INSERT INTO attempts
        (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
         status, nonce_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7,
               now() + interval '8 hours')
       ON CONFLICT (id) DO NOTHING`,
      [
        seed.attemptId,
        activeRepositoryId,
        activeRevisionId,
        githubAuthorId,
        proof.id,
        seed.patch.headSha,
        sha256(seed.attemptId),
      ],
    );
    await client.query(
      `INSERT INTO check_runs
        (revision_id, github_check_run_id, name, status, conclusion,
         public_summary, details_url)
       VALUES ($1, $2, 'UnderstandProof / understanding required', 'in_progress', NULL,
               $3, $4)
       ON CONFLICT (revision_id) DO NOTHING`,
      [
        activeRevisionId,
        `fake-check-${String(seed.number)}`,
        `understanding required for head ${seed.patch.headSha}`,
        `http://localhost:3000/demo/pr/${String(seed.number)}`,
      ],
    );
  }
  await client.query("COMMIT");
  process.stdout.write(
    `Seeded ${String(seeds.length)} local demo pull requests.\n`,
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await database.close();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function patch(
  headDigit: string,
  files: readonly {
    path: string;
    additions: number;
    deletions: number;
    patch: string;
  }[],
): PullRequestPatch {
  return {
    baseSha,
    headSha: headDigit.repeat(40),
    files: files.map((file) => ({ ...file, kind: "text" as const })),
  };
}

function githubSource(
  seed: (typeof seeds)[number],
  githubPullRequestId: string,
): GithubRevisionSourceV1 {
  return {
    githubPullRequestId,
    number: seed.number,
    state: "open",
    draft: false,
    title: seed.title,
    body: "Deterministic offline source for the local demo profile.",
    authorId: githubAuthorId,
    authorLogin: "demo-contributor",
    headSha: seed.patch.headSha,
    baseSha: seed.patch.baseSha,
    changedFiles: seed.patch.files.length,
    isFork: false,
    files: seed.patch.files.map((file) => ({
      sha: seed.patch.headSha,
      filename: file.path,
      previousFilename: file.previousPath ?? null,
      status: "modified",
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      patch: file.patch ?? null,
      gitKind: "blob",
    })),
    limitsHit: {
      files: false,
      patchBytes: false,
      patchUnavailable: false,
    },
  };
}
