# Release process

## Release channels

- `v0.x.y-alpha.n`: engineering preview.
- `v0.x.y-beta.n`: feature-complete candidate with documented gaps.
- `v0.x.y`: stable within the `0.x` compatibility policy.
- `v1.x.y`: stable public contracts and migrations.

A release publishes under its channel, which `scripts/release-channel.mjs`
reads from the version: npm dist-tag and container tag `alpha`, `beta` or `rc`
for that prerelease, `latest` for a version with no prerelease id. Any other
prerelease id fails `pnpm check` and stops the release before it publishes.
Before 1.0 every prerelease also moves npm's `latest` and the image's
`:latest`, so those two follow every release while `alpha` stays on the last
alpha once betas begin.

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
   Move `## [Unreleased]` into `## [<version>] - <date>`: that section becomes
   the GitHub release's notes, with each wrapped line joined to the one it
   continues because a release body shows every newline as a line break. Every
   breaking change must be marked **Breaking:** there, as
   [GOVERNANCE.md](../GOVERNANCE.md#compatibility) requires before `1.0.0`.
   `pnpm docs:check` fails while `package.json`'s version has no section or an
   empty one, so the version bump's pull request cannot merge without notes.
7. Run the release dry run on the commit to be tagged (`gh workflow run
   release-dry-run.yml --ref main`, or open the Actions tab) and wait for it to
   pass: it builds the binaries and every release file through the same steps
   the tag release uses, checks the versions, runs `pnpm security:audit`,
   extracts and prints the release notes, `npm publish --dry-run`s every
   package in publish order under the release's channel and checks the
   release's asset list, all without
   publishing. Each of these stops a tag release too, but only once the tag
   exists.
8. Create a signed, protected `v*` tag only from an approved main-branch commit.
9. Once the tag's npm packages are out, publish the MCP Registry listing from
   the tagged checkout: `mcp-publisher login github`, then `mcp-publisher
   publish`. The Registry checks `server.json`'s name against the CLI's
   `mcpName`, case and all, and installs the version `server.json` names, so
   both come from `pnpm versions:set`, never by hand.

## Automated artifacts

The tag workflow:

- rebuilds and tests from the immutable tag;
- creates a portable Node runtime archive;
- creates Python wheel and source distributions;
- creates a source archive;
- builds the single executable for linux-x64, linux-arm64, darwin-arm64 and
  win-x64 with the same workflow every pull request runs, smoke-tests each, and
  attaches them unsigned (ad-hoc signed on macOS);
- generates an SPDX JSON SBOM;
- writes SHA-256 checksums, the single executables included;
- generates signed Sigstore-backed GitHub provenance attestations;
- publishes every public `@melra/*` package to npm by **trusted publishing**
  (see below), with provenance, under the release's channel as dist-tag. It
  publishes in dependency order (`scripts/publish-order.mjs`), the CLI last, so
  a run that stops partway leaves no published package whose `@melra/*`
  dependencies are missing. The whole order is worked out before the first
  publish, so a dependency cycle stops the run with nothing published;
- publishes the artifacts to the GitHub release, whose notes are the version's
  `CHANGELOG.md` section (`node scripts/check-changelog.mjs --notes <file>`). A
  version with no section, or an empty one, stops the run before anything is
  published;
- last, once all of that and the install smoke (the published CLI installed
  from npm and driven over MCP stdio on Linux, macOS and Windows) have passed,
  builds and publishes the container to GitHub Container Registry with
  provenance for Linux AMD64 and ARM64, tagged with the version, the channel,
  and `:latest` on every release before 1.0. A run that stops anywhere moves
  no container tag.

npm moves first, so its tags and the image's differ in exactly these cases:

- from the npm publish until the container job finishes, and for as long
  after as a run that failed later on stays failed: npm's channel dist-tag
  (and its `latest`) already name the new version while the image's still
  name the previous one. Re-running the failed jobs finishes the release and
  moves the image;
- when npm refuses to move `latest` (see below), npm's `latest` stays behind
  while `:latest` moves;
- the `retag-existing` run moves npm's `latest` only.

Verify downloaded artifacts:

```bash
sha256sum --check --ignore-missing SHA256SUMS &&
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
harmless. Moving the `latest` dist-tag needs one more setting the script does
not grant: in each package's trusted-publisher settings on npmjs.com, enable
**Allow npm dist-tag**. Without it the release still publishes and the GitHub
release is still created, but `latest` stays where it was and the run warns
with the command to move it by hand.

**A failed release run can be re-run.** Packages already on the registry at the
tag's version are skipped, so a re-run continues with the provenance check,
the GitHub release, the install smoke and then the container. A re-run uses the workflow as it was
at the tag, so this applies to tags cut after this change. A **brand-new** package cannot be trusted until it exists on the
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
