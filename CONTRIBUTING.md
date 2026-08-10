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

## Development setup

```bash
git clone https://github.com/XAGI-Lab/melra.git
cd melra
pnpm install --frozen-lockfile
pnpm build          # required before tests: they import siblings through dist/
pnpm check          # the full CI gate
```

Use Node.js 22 or newer and pnpm 9.5.

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
- [Roadmap milestones](https://github.com/XAGI-Lab/melra/milestones) — P2, P3
  and P4, each with a design issue open *before* the code exists. That is the
  cheapest moment to disagree with it.

## Pull requests

Keep changes focused. A pull request should include:

- the problem and intended user outcome;
- tests for new or changed behavior;
- security and compatibility impact;
- documentation for public contracts.

Protocol, policy, storage, and release changes require maintainer review.

Do not contribute customer data, credentials, deployment identifiers, private
prompts, billing records, or code you do not have the right to license.

## Developer Certificate of Origin

By contributing, you certify the Developer Certificate of Origin 1.1:

<https://developercertificate.org/>

Sign commits with:

```text
Signed-off-by: Your Name <your-email@example.com>
```

## Reporting security problems

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md).
