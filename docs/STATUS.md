# Project Status

Last updated: 2026-08-09

Version: `0.3.0-alpha.10`

## Engineering Complete

- ✅ **All 338 tests passing** (336 Vitest, 2 Python pytest)
- ✅ **Versions consistent** across the root manifest, every `apps/*` and `packages/*` manifest, the protocol constant, sdk-py, and both uv locks (`pnpm versions:check`)
- ✅ **Gate green**: `pnpm check`, `pnpm e2e`, `pnpm security:audit` all pass
- ✅ **Conformance L3 verified effects**: `melra conformance` reports 14/14 checks against this build's own stdio server, and L1 under `MELRA_UNHINGED=1` — both asserted in CI. Levels and their limits: [CONFORMANCE.md](CONFORMANCE.md)
- ✅ **Install paths documented**: npm, container, release tarball, source
- ✅ **Registry install verified end to end**: the `installed` job on ubuntu, macOS and Windows installs the just-published `@melra/cli` from npm, passes `melra doctor`, and drives a real stdio session to `verified_success`; `npx -y @melra/cli@alpha conformance` in an empty directory earns level 3 (14/14)
- ✅ **Release artifacts published**: GitHub release v0.3.0-alpha.10 with 6 assets, container at `ghcr.io/xagi-lab/melra:alpha` and `:v0.3.0-alpha.10` (linux/amd64 + linux/arm64), all 14 npm packages on the `alpha` and `latest` dist-tags with provenance attestation

`0.3.0-alpha.7` is the one gap in that history: its container image built, but
the `artifacts` job failed on a stale `uv.lock` before reaching the registry, so
no npm packages or GitHub release exist for that tag. `0.3.0-alpha.8` carried the
fix, and `pnpm versions:check` now fails on the mismatch locally instead of
leaving it for a tag push to discover.

## Requires Project Action

### Manual Named-Client Verification

**From VALIDATION.md:**
> Before an alpha is called broadly installable, the built artifact must also be exercised in the then-current versions of:
> - Claude Desktop
> - Cursor
> - VS Code's MCP support
> - at least one additional independent MCP inspector or client

**Current state:** Automated compatibility claim is official MCP SDK over stdio (TypeScript + Python). Named graphical clients remain release-gated until manually exercised.

**Action:** Install `npx @melra/cli@alpha` or download the `v0.3.0-alpha.10` release artifact, configure each client per docs/INSTALLATION.md, verify discovery/plan/execute/receipt cycle.

### Independent Security Review

**From VALIDATION.md:**
> Before `1.0`, a clean released artifact must pass on supported Linux, macOS, and Windows machines, and an independent security review must resolve all critical findings.

**Current state:** Threat model reviewed for 0.3.0-alpha.10, no independent audit yet.

**Action:** Engage external security reviewer when approaching beta/1.0.

## Known Alpha Scope Limits

Documented in docs/VALIDATION.md "Known alpha limitations":
- Stdio and loopback HTTP transports. The HTTP surface takes the operator's
  token, or an OAuth 2.1 client a person approved in a browser; it is not
  reachable off loopback and is not multi-tenant
- Browser sessions thrown away per run unless `MELRA_BROWSER_PROFILE` names a
  directory to keep
- Computer OCR/visual targeting roadmap; element targeting works on macOS and
  Windows but not on Linux/X11
- Node SQLite experimental warning (suppressed in the CLI; visible when the
  storage package is embedded as a library)
- Unhinged mode (`--unhinged` / `MELRA_UNHINGED=1`) is an explicit opt-out of the
  entire safety model, not a scope limit. Nothing in this document's safety
  claims applies to a process running in it.

These are documented boundaries, not defects.

## Summary

**Code complete and installable.** The codebase is production-ready for the declared alpha scope, and all four install paths — npm, container, release tarball, source — are published and documented. Remaining items are external verification (manual client exercise, independent security review) and known alpha boundaries (documented, not broken).

`npx @melra/cli@alpha` is the primary install path.
