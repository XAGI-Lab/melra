# Contributing to MELRA

Thank you for helping make agent execution safer, more reliable, and easier to
verify.

## Before you start

- Read [GOVERNANCE.md](GOVERNANCE.md).
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- For security-sensitive work, read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- Search existing issues and discussions before opening a new proposal.

### Does this belong in MELRA?

MELRA is the layer below reasoning: the LLM reasons, the harness manages the
loop, MELRA owns the effect lifecycle. One question settles most scope
arguments before they start:

> **Would this feature still make sense if the effect request came from
> ordinary deterministic software rather than an LLM?**

Yes — authorization, capabilities, idempotency, credential isolation, recovery,
verification, effect history. It belongs here.

No — prompt optimization, model selection, conversation memory, a planner,
agent personality, subagent reasoning. It belongs to the harness above, and
adding it here would make MELRA's guarantees depend on a model's judgement.

## Documentation-only changes

Markdown-only contributions do not need Node.js or pnpm setup. Before opening
the pull request, run `git diff --check`; GitHub Actions runs the repository
checks for every pull request. Each commit still needs a sign-off, including
one made in GitHub's web editor (see
[Developer Certificate of Origin](#developer-certificate-of-origin)), and you
need to have signed the [CLA](#contributor-license-agreement).

## Development setup

```bash
git clone https://github.com/XAGI-Lab/melra.git
cd melra
pnpm install --frozen-lockfile
pnpm build          # required before tests: they import siblings through dist/
pnpm check          # the full CI gate
```

Use Node.js 22.13 or newer, or 23.4 or newer, and pnpm 9.5.

**[docs/CONTRIBUTING_GUIDE.md](docs/CONTRIBUTING_GUIDE.md) is the map**: which
files a given kind of change touches, the non-obvious policy defaults, the house
style, and the checklist a maintainer will read your pull request against. Read
it before your first change — it is the difference between a two-file patch and
a six-file one that actually lands.

## Where to start

- [`good first issue`](https://github.com/XAGI-Lab/melra/labels/good%20first%20issue)
  — scoped so the description names the files to open.
- [`help wanted`](https://github.com/XAGI-Lab/melra/labels/help%20wanted)
  — larger, still well-specified.
- [Roadmap milestones](https://github.com/XAGI-Lab/melra/milestones) — P2 and
  P3 are still open (P4 has shipped), each with a design issue open *before*
  the code exists. That is the cheapest moment to disagree with it.

## Pull requests

Keep changes focused. A pull request should include:

- the problem and intended user outcome;
- tests for new or changed behavior;
- security and compatibility impact;
- documentation for public contracts.

Protocol, policy, storage, and release changes require maintainer review.

Do not contribute customer data, credentials, deployment identifiers, private
prompts, billing records, or code you do not have the right to license.

## Licensing of contributions

MELRA is dual-licensed ([LICENSING.md](LICENSING.md)). The kernel is
AGPL-3.0-only, and XAGI Labs Private Limited also offers it under a commercial
license. `packages/sdk-ts`, `packages/protocol`, `sdk-py` and `examples/` are
Apache-2.0, and a contribution to them is licensed under Apache-2.0 and stays
so.

A new source file takes the header for its path; `pnpm licenses:check --fix`
writes it.

## Contributor License Agreement

Before your first pull request can be merged, sign the
[Contributor License Agreement](CLA.md). The CLA check on the pull request asks
you to post one comment saying you agree; that signs it for all your
contributions. You keep your copyright. The CLA lets XAGI Labs offer your
contribution under the AGPL and under its commercial license, which the dual
license depends on. If your employer has rights in your work, make sure they
allow you to contribute under it first.

The CLA does not replace the sign-off below: every commit needs both.

For maintainers: any change to the text of `CLA.md` makes a new version. Raise
its version line, and on the `cla-signatures` branch move `signatures/cla.json`
to an archive file named for the old version, so that the check asks everyone
to sign the new text.

## Developer Certificate of Origin

By contributing, you certify the Developer Certificate of Origin 1.1:

<https://developercertificate.org/>

From a terminal, create each commit with `-s` so Git adds the trailer automatically:

```bash
git commit -s -m "Describe the change"
```

This adds the `Signed-off-by: Your Name <your-email@example.com>` trailer using
your configured name and email. Every commit in the pull request needs a sign-off.
In GitHub's web editor, include the same trailer in the commit message.

## Reporting security problems

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md).
