# Dogfooding UnderstandProof on its own repository

UnderstandProof was previously named SlopProof. The existing GitHub App and required
check keep their legacy identifiers during this transition; see the
[rename compatibility notes](../operations/understandproof-rename.md).

UnderstandProof may become a required check on `pascalkienast/understandproof` only after it
has produced a successful check on that repository. GitHub only offers an App
as the expected status-check source after the App has submitted a recent check.

## Bootstrap sequence

1. Publish the repository without requiring the UnderstandProof check.
2. Install the production GitHub App on this repository only.
3. Open a small bootstrap pull request that changes documentation.
4. Complete Practice, Live Proof and maintainer review.
5. Confirm the check named `UnderstandProof / understanding required` completed on the
   pull request's current head SHA.
6. Record the GitHub App integration ID shown as the check source.
7. Create the `main` ruleset described below.
8. Open a second pull request and prove that merge remains blocked until CI and
   UnderstandProof pass.

## Main-branch ruleset

Target `refs/heads/main` and enable:

- require a pull request before merging;
- require conversation resolution;
- block force pushes and branch deletion;
- require `ci / verify`;
- require `supply-chain / dependency-audit`;
- require `supply-chain / image-sbom-scan`;
- require `UnderstandProof / understanding required` from the UnderstandProof GitHub App;
- require the branch to be current with `main`.

The repository currently has one maintainer, so the ruleset must not require an
approval that the pull-request author cannot supply. Maintainer review inside
UnderstandProof remains separate from GitHub code review.

GitHub documents that a required status check can be bound to its expected App
source. Do not leave the UnderstandProof check at `any source` after the App has
submitted its bootstrap check.

## Break-glass actor

Add the repository owner as a bypass actor with mode **For pull requests only**.
This preserves a pull request and GitHub audit trail while allowing a repair if
the UnderstandProof service cannot complete its own required check. Do not configure
an always-exempt bypass and do not permit direct pushes to `main`.

Use the bypass only when all of these conditions hold:

1. UnderstandProof is unavailable or the repair changes the component that produces
   the required check.
2. `ci / verify` and the supply-chain checks pass.
3. The pull request states the incident or outage reference and why the bypass
   is necessary.
4. Another human reviews the patch when one is available. If none is available,
   the maintainer records that fact.
5. The maintainer restores the normal UnderstandProof path and opens a follow-up
   dogfood pull request before unrelated work merges.

After each bypass, export the ruleset insight or audit evidence available to the
account, link it from the repair pull request and add a regression test when the
service caused the deadlock.

References:

- [Creating repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Required status-check troubleshooting](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
