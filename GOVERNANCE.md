# Governance

MELRA is an XAGI Labs-led open-source project.

## Roles

### Contributors

Anyone who submits issues, documentation, tests, design feedback, or code.

### Maintainers

Maintainers review changes, triage issues, cut releases, and protect the
versioned contract. The initial maintainers are:

- `@dhe-eraj-s`
- `@bhavana-sanal`

Maintainers may add maintainers after sustained, trusted contribution.

### Security maintainers

Security maintainers own private vulnerability intake, embargoed fixes, and
release advisories. They are listed in `CODEOWNERS`.

## Decision process

- Routine changes use pull-request consensus.
- Protocol, security posture, licensing, and compatibility changes need
  approval from two maintainers when two are available.
- A maintainer with a direct conflict of interest should not be the only
  approver.
- Security maintainers may merge an embargoed fix before public discussion.

## Licensing

The kernel is AGPL-3.0-only, and XAGI Labs Private Limited, as its licensor,
also offers it under a commercial license; the SDKs and examples are
Apache-2.0 ([LICENSING.md](LICENSING.md)). Contributions are accepted under the
[CLA](CLA.md) and the DCO ([CONTRIBUTING.md](CONTRIBUTING.md)). The name and
logo follow [TRADEMARKS.md](TRADEMARKS.md). A change to any of these is a
licensing change under the decision process above.

## Compatibility

Once a package reaches `1.0.0`, breaking changes require:

- a documented migration path;
- a deprecation period;
- a major version.

Before `1.0.0`, breakage is allowed but must be called out in release notes.

## Project decisions

MELRA decisions are made for the product and its users. Contributions are
evaluated on technical quality, safety, compatibility, and alignment with the
roadmap.
