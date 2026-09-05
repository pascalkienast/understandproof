# UnderstandProof rename and compatibility

UnderstandProof is the new name of SlopProof, not a separate service or installation.
The repository is now <https://github.com/pascalkienast/understandproof>. The brand core is **Proof of Understanding**. The first application is code;
texts and other media are a longer-term direction, not new supported inputs
in this release.
The proof supplies evidence for review, not a guarantee of understanding or
code quality.

## Changed in this release

- Product name, landing wordmark, metadata, interface copy, GitHub comment
  heading, support/security links, and documentation.
- Root package name `understandproof`, private workspace packages `@understandproof/*`, their
  imports, build filters, Next.js transpilation list, and lockfile links.
- The exported database type is `UnderstandProofDatabase`.
- The repository mark is `understandproof-mark.svg`; its artwork is unchanged.
- Hosted origin: `https://understandproof.paskie.me`; the legacy origin remains
  available during the coordinated DNS/TLS, OAuth/webhook, runtime-origin, and
  storage-CORS transition.

Existing clones should update their remote:

```bash
git remote set-url origin https://github.com/pascalkienast/understandproof.git
pnpm install --frozen-lockfile
```

Do not create a new repository at `pascalkienast/slopproof`: that would replace
GitHub's redirect. GitHub does not redirect `uses: owner/repo/...` calls to an
action hosted by a renamed repository; update such consumers explicitly if
any are introduced or discovered. See [GitHub's rename documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository).

## Intentionally stable interfaces

Do not globally replace every occurrence of `slopproof`. These are live
compatibility contracts rather than the public brand:

- **GitHub App identity:** The existing App now uses the installation URL
  `https://github.com/apps/understandproof`. Its numeric identity and existing
  installations remain unchanged; this is not a replacement App.
- **Repository policy:** `.slopproof.yml` remains the authoritative policy
  filename. No new filename or ambiguous dual-policy precedence is introduced.
- **Authentication and protocol:** `slopproof_session`, other existing cookies,
  token issuers/audiences, `X-SlopProof-*` proxy headers, internal headers,
  cryptographic `slopproof:*` associated-data prefixes, and recording protocol
  identifiers remain unchanged. Existing encrypted records and golden vectors
  must continue to decrypt and validate.
- **Persistence and idempotency:** database names/roles, SQL migrations,
  deterministic-ID namespaces, object-storage names/prefixes, and the hidden
  PR-comment marker `<!-- slopproof:understanding-check -->` stay unchanged.
  Existing comments are updated in place, not duplicated under a new marker.
- **Versioned provider behavior:** the existing semantic prompt's historical
  name is retained. A branding release does not silently revise a versioned
  model prompt or re-evaluate existing evidence.
- **Operations:** `SLOPPROOF_*` variables, Compose project/volume names,
  systemd unit filenames, `/opt/slopproof`, `/etc/slopproof`, static landing
  paths, image tags, `.slopproof-*` manifests, receipt schemas, and
  `SlopProof-Backups` paths remain compatible with existing releases and backup
  verification. Their explanatory text can use UnderstandProof.
- **Historical screenshots:** manually selected product-tour WebPs are
  unchanged. Their captions/alt text still accurately describe the earlier
  SlopProof interface. Replace them only with newly approved captures.

No database migration, re-encryption, data move, infrastructure rename, or
change to proof policy is required by this release. A repository merge alone
does not deploy the renamed interface or static landing page.

## Release and follow-up checks

1. Run the normal verification/build and production release workflow. Publish
   the generated landing assets along with the application using the existing
   [deployment runbook](production-deployment.md).
2. On the renamed repository, verify a fresh signed PR delivery against its
   numeric repository ID and new owner/name. Confirm the existing installation
   binds to it, updates the persisted repository name, and creates the normal
   revision-bound comment/check. Do not insert replacement repository rows or
   disable the gate to work around a stale binding.
3. Verify contributor OAuth, mobile handoff, maintainer review, and the exact
   required-check name on a fresh attempt. Existing sessions and pending
   installations must retain their behavior.
4. If the registered App is later renamed, preserve its identity/installations,
   verify the new installation URL, and update links only after it works.
5. Coordinate emitted check names with repository rulesets as described below.

## Required-check rename

The emitted check name is now `UnderstandProof / understanding required`.
Change the required status-check context from `SlopProof / understanding required`
to that name, keeping the existing GitHub App identity and all other required
checks unchanged. For the hosted repository, the App ID is `4570049`.

The operator accepts that existing open PRs can wait for the new name during
this cutover. Until the updated application is deployed, the running version
still emits the old name. This is blocking, not an automatic pass. After
deployment, verify a fresh PR revision reports the new check from the same App.
Existing runs may retain the old name until the application next updates them;
there is no historical evidence rewrite or database migration.

A rollback to an older application also requires restoring the old required
check context. Do not remove the required gate or change its App binding.
