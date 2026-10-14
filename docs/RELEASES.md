# Release process

## Release channels

- `v0.x.y-alpha.n`: engineering preview.
- `v0.x.y-beta.n`: feature-complete candidate with documented gaps.
- `v0.x.y`: stable within the `0.x` compatibility policy.
- `v1.x.y`: stable public contracts and migrations.

## Maintainer checklist

1. Confirm the version is identical in the protocol, Node packages, and Python
   package.
2. Run `pnpm check`, `pnpm evals`,
   `pnpm --filter @melra/evals evaluate:durable-core -- --publishable`,
   `pnpm e2e`, `pnpm pack:check`, and `pnpm security:audit`.
3. Build the image, run `melra doctor`, then run `pnpm docker:smoke` to
   exercise an actual stdio MCP session inside the hardened container.
4. Run dependency, secret, license, and public-content scans.
5. Record the supported OS and named-client results in `VALIDATION.md`.
6. Review `SECURITY.md`, the threat model, compatibility notes, and changelog.
7. Create a signed, protected `v*` tag only from an approved main-branch commit.

## Automated artifacts

The tag workflow:

- rebuilds and tests from the immutable tag;
- creates a portable Node runtime archive;
- creates Python wheel and source distributions;
- creates a source archive;
- generates an SPDX JSON SBOM;
- writes SHA-256 checksums;
- generates signed Sigstore-backed GitHub provenance attestations;
- publishes every public `@melra/*` package to npm by **trusted publishing**
  (see below), with provenance;
- publishes the artifacts to the GitHub release;
- builds and publishes the container to GitHub Container Registry with
  provenance for Linux AMD64 and ARM64.

Verify downloaded artifacts:

```bash
sha256sum --check SHA256SUMS
gh attestation verify <artifact> --repo XAGI-Lab/melra
```

Artifact attestations prove which GitHub workflow built a digest. They do not
replace code review, dependency review, or runtime sandboxing.

## npm trusted publishing

No npm token is stored anywhere. Each public `@melra/*` package names
`.github/workflows/release.yml` in `XAGI-Lab/melra` as its trusted publisher,
and the registry accepts that workflow's GitHub OIDC token instead of a
secret: nothing to expire, rotate, or leak. The workflow installs npm 11.21.0,
the first release that also moves dist-tags this way.

Register the trust once, as a package owner with 2FA, and again whenever a
package is added (npm refuses tokens for this, so it is never a CI step):

```bash
npm login
node scripts/npm-trust.mjs
```

The script skips packages that already trust the workflow, so rerunning it is
harmless. A **brand-new** package cannot be trusted until it exists on the
registry: publish its first version by hand as an owner, then run the script.

Once a release has published this way, set each package to *Require two-factor
authentication and disallow tokens* (Settings → Publishing access) and delete
any remaining npm automation tokens.

## Rollback

Releases are immutable. If a release is unsafe:

1. mark it clearly in the GitHub release notes;
2. publish a security advisory when appropriate;
3. publish a fixed version rather than replacing existing artifacts;
4. document local-data migration or recovery steps;
5. remove a container tag only when continued distribution creates greater
   harm, while retaining the advisory and audit trail.
