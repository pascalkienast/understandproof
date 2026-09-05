import { notFound } from "next/navigation";
import { getWebRuntime } from "../../../../lib/runtime";
import { ProofHandoff } from "./proof-handoff";

export const dynamic = "force-dynamic";

type PullRequestView = {
  number: number;
  head_sha: string;
  attempt_id: string;
  status: string;
  question_budget: number;
  risk_explanation: {
    title?: string;
    riskLevel?: string;
    rationale?: string[];
  };
};

export default async function PullRequestPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const number = Number.parseInt((await params).number, 10);
  if (!Number.isSafeInteger(number)) notFound();
  const app = await getWebRuntime();
  const result = await app.database.pool.query<PullRequestView>(
    `SELECT pull_request.number, revision.head_sha, attempt.id AS attempt_id,
            attempt.status, proof_plan.question_budget,
            proof_plan.risk_explanation
     FROM pull_requests pull_request
     JOIN repositories repository ON repository.id = pull_request.repository_id
     JOIN pull_request_revisions revision
       ON revision.pull_request_id = pull_request.id AND revision.is_current = true
     JOIN proof_plans proof_plan ON proof_plan.revision_id = revision.id
     JOIN attempts attempt
       ON attempt.revision_id = revision.id AND attempt.proof_plan_id = proof_plan.id
     WHERE repository.owner = 'acme' AND repository.name = 'cachekit'
       AND pull_request.number = $1
     LIMIT 1`,
    [number],
  );
  const pullRequest = result.rows[0];
  if (!pullRequest) notFound();

  return (
    <main className="shell flow-shell">
      <a className="back-link" href="/demo">
        ← Local pull requests
      </a>
      <div className="check-header">
        <div>
          <p className="eyebrow">UnderstandProof / understanding required</p>
          <h1 className="flow-title">
            {pullRequest.risk_explanation.title ?? `PR #${String(number)}`}
          </h1>
        </div>
        <span className="status-pill">
          {pullRequest.status.replaceAll("_", " ")}
        </span>
      </div>
      <div className="sha-row">
        <span>Current head SHA</span>
        <code>{pullRequest.head_sha}</code>
      </div>
      <p className="lede">
        The planner selected {pullRequest.question_budget} focused live question
        {pullRequest.question_budget === 1 ? "" : "s"} for this exact patch.
        Practice is optional; proof can start immediately.
      </p>
      <div className="choice-grid">
        <section className="choice-card practice-card">
          <p className="eyebrow">Optional learning space</p>
          <h2>Practice your understanding.</h2>
          <p>
            Map the patch, risks and test surface without revealing the live
            proof questions.
          </p>
          <a className="button" href={`/demo/pr/${String(number)}/practice`}>
            Open practice
          </a>
        </section>
        <section className="choice-card proof-card">
          <p className="eyebrow">Direct path</p>
          <h2>Prove you know what you ship.</h2>
          <p>
            Continue on a phone, answer all questions in one uninterrupted take,
            then wait for review.
          </p>
          <ProofHandoff
            attemptId={pullRequest.attempt_id}
            establishDemoSession
          />
        </section>
      </div>
      <section className="notice-card">
        Video chunks are encrypted in the phone browser before direct upload.
        The object store receives ciphertext only. A model may recommend; a
        maintainer decides.
      </section>
    </main>
  );
}
