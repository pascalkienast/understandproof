<p align="center">
  <img src="understandproof-mark.svg" width="112" alt="UnderstandProof mark">
</p>

# UnderstandProof

**Proof of Understanding.**

Creating an output and understanding it are different things. UnderstandProof
makes room for the person who needs to explain what they take responsibility
for, whether or not they created it themselves.

The first application is code: AI can write the pull request; the person
proposing it should be able to explain what it does, why it belongs, and where
it can fail.

UnderstandProof turns that understanding into a required GitHub check. The author
explains the exact patch on live video, giving maintainers patch-bound evidence
before merge. Understanding complements code review and tests; it does not
replace them.

[![CI](https://github.com/pascalkienast/understandproof/actions/workflows/ci.yml/badge.svg)](https://github.com/pascalkienast/understandproof/actions/workflows/ci.yml)
[![Supply chain](https://github.com/pascalkienast/understandproof/actions/workflows/supply-chain.yml/badge.svg)](https://github.com/pascalkienast/understandproof/actions/workflows/supply-chain.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Run the full stack yourself or try
[understandproof.paskie.me](https://understandproof.paskie.me). Each proof stays bound to
the current head SHA, so a new push requires a fresh explanation.

<p align="center">
  <img src="docs/assets/product-tour/contributor-proof.webp" width="920" alt="SlopProof contributor page with optional Practice and required Proof choices">
</p>
<p align="center"><sub>The contributor view for a pull request: Practice is optional. Proof is required.</sub></p>

## How it works

1. The GitHub App receives a pull-request event and binds a check to that head
   SHA.
2. **Practice** is optional. You can study patch-bound learning goals and
   private coaching. Practice never counts as the proof.
3. **Proof** opens on a phone through a one-time QR link. You answer a
   risk-adjusted set of patch questions in one continuous recording. The
   recording tab has to stay in the foreground. Switch to another app, a
   second screen, the lock screen, or another tab, and the take aborts as
   `visibility_lost`. That is the help/no-help guarantee. You cannot read
   notes on a second screen while the take runs.
4. The browser encrypts each recording chunk before upload. The object store
   gets ciphertext only.
5. A worker builds a bounded transcript and a few frames. A multimodal model
   compares those with the patch and rubric.
6. A maintainer can review the take and the model finding.
7. A new push invalidates the attempt. Evidence lasts at most 24 hours, and
   may be deleted as soon as a maintainer accepts it.

UnderstandProof does not run pull-request code. It does not do face recognition,
gaze tracking, room scanning, identity verification, or persistent contributor
scoring.

## Product tour

The GitHub App comment shows the current interface. Some other production
captures still show earlier branding; those historical captures remain unaltered.

The flow starts where contributors already work. The GitHub App posts a
revision-bound link directly on the pull request.

<p align="center">
  <img src="docs/assets/product-tour/github-comment.webp?v=0964f60e8b5e" width="920" alt="Automatic UnderstandProof GitHub App comment linking to the contributor flow">
</p>

The contributor checks the camera and privacy terms, then answers the
patch-bound questions in one continuous take.

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/assets/product-tour/privacy-check.webp" alt="Camera and privacy check before the live proof">
      <br><sub>Preflight explains the one-take and retention rules.</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/assets/product-tour/one-take.webp" alt="Live one-take proof with patch reference and question">
      <br><sub>Each live question stays bound to the current revision.</sub>
    </td>
  </tr>
</table>

The result returns to the same head SHA on GitHub.

<p align="center">
  <img src="docs/assets/product-tour/github-passed.webp" width="760" alt="GitHub pull request with the SlopProof required check passed">
</p>

<details>
  <summary><strong>Optional Practice</strong> — inspect the patch map and rehearse privately</summary>
  <br>
  <p align="center">
    <img src="docs/assets/product-tour/practice.webp" width="820" alt="Practice page with patch map and understanding coach">
  </p>
</details>

<details>
  <summary><strong>Maintainer review</strong> — inspect private evidence when the model asks for review</summary>
  <br>
  <p align="center">
    <img src="docs/assets/product-tour/review-evidence.webp" width="820" alt="Maintainer review with video, transcript, timestamps, and decision controls">
  </p>
</details>

## See it

- Live landing: [understandproof.paskie.me](https://understandproof.paskie.me)
- Local demo: <http://localhost:3000/demo> after `docker compose up --build`
- Curated production screenshots: [docs/assets/](docs/assets/README.md)

## Local demo

The reference demo needs Docker with Compose:

```bash
docker compose up --build
```

Open <http://localhost:3000/demo>. The stack creates three synthetic pull
requests and uses local fake adapters for GitHub, generation, transcription,
and multimodal evaluation. Demo ports bind to `127.0.0.1` by default. Do not
expose `DEMO_MODE=true` to a network.

For development without the application containers, install Node.js 24 and
pnpm 10.8:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:keys
pnpm verify
```

PostgreSQL integration tests also need `TEST_DATABASE_URL`. Playwright needs a
migrated and seeded database. The CI workflow records the order.

## Production shape

A production deployment needs:

- a GitHub App with the permissions and webhook events listed in the
  [self-hosting guide](docs/operations/self-hosting.md);
- PostgreSQL 18 with `pg-boss` in the same database;
- private S3-compatible object storage with browser CORS and a lifecycle
  backstop;
- an HTTPS reverse proxy that serves the static `landing/` payload at `/`;
- a transcription provider and a multimodal model provider;
- a local RSA wrapping key pair or a compatible KMS adapter;
- separate Web, Worker, GitHub Control, and migration processes.

`DEPLOYMENT_PROFILE=production` rejects demo adapters, loopback or public HTTP
endpoints, placeholder secrets, and incomplete provider configuration. The
checked-in automation under `scripts/production-*` is the maintainer's current
hardened profile. There is no one-command installer.

UnderstandProof is pre-1.0. The hosted flow has run against a real pull request:
Practice, encrypted phone recording, provider processing, maintainer review,
check completion, retention, backup, and restart. Config and migrations can
still change before a stable release.

## Security and privacy

UnderstandProof handles video evidence and repository content. Read these before you
run it for other people:

- [Threat model](docs/security/threat-model.md)
- [Provider data flow](docs/privacy/provider-data-flow.md)
- [Recording cryptography](docs/recording-crypto-v1.md)
- [Production configuration](docs/operations/production-configuration.md)
- [Incident response](docs/security/incident-response.md)
- [Security reporting](SECURITY.md)

Provider terms, lawful basis, retention notices, and data-processing agreements
stay with the operator. The controls in this repository do not prove a third
party's retention or training policy.

## Repository map

- `landing/`: static marketing source and published output for `GET /`
- `apps/web`: contributor, mobile, and maintainer interfaces plus HTTP routes
- `apps/worker`: queues, private media processing, providers, and retention
- `apps/github-control`: installation-token and GitHub reconciliation process
- `packages/domain`, `packages/db`, `packages/policy`: state machine, database
  constraints, and review policy
- `packages/media`, `packages/storage`: encrypted recording protocol and S3
  transport
- `packages/analysis`, `packages/questions`, `packages/providers`: bounded patch
  analysis, planning, and provider adapters
- `docs`: project status, security, privacy, maintainer, and operations guides
- `scripts`: verification, release, backup, and deployment tooling

[Browse the documentation](docs/README.md) or read the current
[project status](docs/project-status.md).

Previously named SlopProof. See the [rename compatibility notes](docs/operations/understandproof-rename.md)
for the existing App link, check name, and deployment settings retained during
the transition.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security
reports go through GitHub's private vulnerability-reporting flow, not public
issues. Support routes are in [SUPPORT.md](SUPPORT.md).

The project is maintained by [Pascal Kienast](https://github.com/pascalkienast).

## License

Copyright © 2026 Pascal Kienast and contributors. UnderstandProof is licensed under
the [Apache License, Version 2.0](LICENSE).
