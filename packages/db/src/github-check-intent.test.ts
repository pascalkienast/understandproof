import { describe, expect, it } from "vitest";
import {
  parseGithubCheckIntent,
  type GithubCheckIntent,
} from "./github-production";

const baseIntent: GithubCheckIntent = {
  revisionId: "10000000-0000-4000-8000-000000000001",
  expectedHeadSha: "a".repeat(40),
  idempotencyKey: "check:intent:review-required",
  reason: "review_required",
  name: "UnderstandProof / understanding required",
  status: "in_progress",
  conclusion: null,
  publicSummary: "maintainer review required for head",
  detailsUrl:
    "https://slopproof.test/revisions/10000000-0000-4000-8000-000000000001",
};

describe("GitHub check intent persist contract", () => {
  it("accepts review_required only as in_progress with no conclusion", () => {
    expect(parseGithubCheckIntent(baseIntent)).toMatchObject({
      reason: "review_required",
      status: "in_progress",
      conclusion: null,
    });
  });

  it("rejects review_required completed+neutral, which would satisfy a required check", () => {
    expect(() =>
      parseGithubCheckIntent({
        ...baseIntent,
        status: "completed",
        conclusion: "neutral",
      }),
    ).toThrow(/review_required checks must stay in_progress/);
  });

  it.each(["technical_retry", "attempt_expired"] as const)(
    "keeps %s fail-closed as completed+action_required",
    (reason) => {
      expect(
        parseGithubCheckIntent({
          ...baseIntent,
          idempotencyKey: `check:intent:${reason}`,
          reason,
          status: "completed",
          conclusion: "action_required",
          publicSummary: `${reason} for head`,
        }),
      ).toMatchObject({
        reason,
        status: "completed",
        conclusion: "action_required",
      });
    },
  );

  it.each([
    "technical_retry",
    "attempt_expired",
    "maintainer_decision",
  ] as const)(
    "rejects neutral for %s because it opens the merge gate",
    (reason) => {
      expect(() =>
        parseGithubCheckIntent({
          ...baseIntent,
          idempotencyKey: `check:intent:neutral:${reason}`,
          reason,
          status: "completed",
          conclusion: "neutral",
          publicSummary: `${reason} for head`,
        }),
      ).toThrow(/neutral conclusions satisfy GitHub required checks/);
    },
  );

  it("requires a replacement attempt to restore a pending check", () => {
    expect(
      parseGithubCheckIntent({
        ...baseIntent,
        idempotencyKey: "check:intent:contributor-retry",
        reason: "contributor_retry",
        publicSummary: "replacement proof ready for head",
      }),
    ).toMatchObject({
      reason: "contributor_retry",
      status: "in_progress",
      conclusion: null,
    });
  });
});
