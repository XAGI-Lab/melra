# Security Policy

## Supported versions

MELRA is alpha software. Only the latest alpha is supported: security fixes
land on `main` and ship in the next alpha release, published to npm under the
`alpha` and `latest` dist-tags and to `ghcr.io/xagi-lab/melra:alpha` and
`:latest` (`:latest` from the release after `0.3.0-alpha.14`; see
[RELEASES](docs/RELEASES.md#release-channels)). Older alphas do not get
backports, so upgrade rather than pin when a fix is announced.

## Report a vulnerability

Report privately through GitHub:
[open a security advisory](https://github.com/XAGI-Lab/melra/security/advisories/new).
Do not put secrets, exploit details, or customer information in a public issue,
discussion, or pull request.

Include:

- affected commit or version;
- affected platform;
- reproduction steps;
- impact;
- suggested mitigation, if known.

XAGI Labs will acknowledge a complete report within three business days and
provide an initial severity assessment within seven business days.

## Security boundaries

MELRA must not require:

- an MELRA account;
- hosted-service credentials;
- telemetry;
- non-public source code.

Mutating tools are explicitly classified, require expected evidence, and are
approval-gated. Evidence is structured and common secret forms are redacted
before persistence. A successful adapter response alone is not proof of goal
completion.

Executable payloads (exact workflow definitions and adapter results) are
sealed with AES-256-GCM under `MELRA_PAYLOAD_KEY` or a mode-`0600` key file,
which MELRA refuses to use if its permissions are wider. Everything else it
stores (task projections, events, receipts, and logs) is redacted but not
encrypted, receipts are not externally signed, and MELRA is not a credential
vault. Losing the payload key makes sealed payloads unrecoverable.

Configure `MELRA_HOME` in a private local directory with appropriate
operating-system permissions. Use a narrow domain and command allowlist. Prefer
stdio, or the mode-`0600` [Unix socket](docs/INSTALLATION.md#over-a-unix-socket),
over loopback HTTP when other users share the machine, and run untrusted tasks
inside the documented [container profile](docs/INSTALLATION.md#docker).

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
