# Licensing

MELRA is dual-licensed. This page is a short map of which part of the
repository is under which license and what that means in practice. The license
texts are in [LICENSE](LICENSE) and [LICENSES/](LICENSES);
where this page and a license text differ, the license text wins. This page is
not legal advice.

## Which path is under which license

| Path | License |
| --- | --- |
| `packages/sdk-ts` (`@melra/sdk`) | [Apache-2.0](LICENSES/Apache-2.0.txt) |
| `packages/protocol` (`@melra/protocol`) | [Apache-2.0](LICENSES/Apache-2.0.txt) |
| `sdk-py` (the `melra` Python package) | [Apache-2.0](LICENSES/Apache-2.0.txt) |
| `examples/`, and the code samples in the documentation | [Apache-2.0](LICENSES/Apache-2.0.txt) |
| Everything else: the kernel (`packages/server`, `runtime-core`, `policy-core`, `storage-sqlite`, `verifier-core`, `receipt-schema`, the file, terminal, browser, HTTP and computer runtimes, `memory`), `apps/` (`@melra/cli`), `evals`, `scripts`, `benchmarks`, the `Dockerfile` and other deployment code, and the documentation's prose | [AGPL-3.0-only](LICENSE), or a commercial license from XAGI Labs Private Limited |
| The official MELRA logo and hero artwork (`docs/assets/melra-logo.png`, `docs/assets/melra-hero.png`) | All rights reserved by XAGI Labs Private Limited; used only as [TRADEMARKS.md](TRADEMARKS.md) allows. Copies distributed before this change under [CC BY-ND 4.0](LICENSES/CC-BY-ND-4.0.txt) keep that license. |

Each source file names its license in its `SPDX-License-Identifier` header, and
each published package carries its own `LICENSE`. `pnpm licenses:check`
(`scripts/check-license-headers.mjs`) holds both to this table.

The SDKs and the protocol package stay Apache-2.0 so that code which only
calls MELRA is unaffected: an agent, harness or application that uses
`@melra/sdk` or the Python SDK can be under any license. Their runtime
dependencies are all under permissive licenses; none of them is AGPL.

## How the dual license works

You may use, change and share the kernel under the GNU Affero General Public
License, version 3 only, at no cost, as long as you follow its terms. If those
terms do not suit you, for example because you want to ship a modified MELRA
inside a closed-source product, or run a modified MELRA as a service without
publishing your changes, XAGI Labs Private Limited also offers the kernel under
a commercial license; contact XAGI Labs through [xagilab.com](https://xagilab.com).

XAGI Labs can offer both only if it may license every contribution both ways,
so contributions need the [Contributor License Agreement](CLA.md) as well as a
DCO sign-off ([CONTRIBUTING.md](CONTRIBUTING.md)). A contribution to an
Apache-2.0 path is licensed under Apache-2.0, and stays so.

## Earlier releases stay Apache-2.0

Every release up to and including `0.3.0-alpha.22` was published under the
Apache License 2.0, and stays under it: if you have one of those releases, or
get it later from npm, PyPI, GitHub or the container registry, you may keep
using, changing and sharing it under Apache-2.0. The same is true of any source
published before the change. The kernel is AGPL-3.0-only from the change
onward. Code that outside contributors gave under Apache-2.0 before the CLA
existed also remains available under Apache-2.0; [NOTICE](NOTICE) lists it.

## Running a modified MELRA as a network service

Section 13 of the AGPL is the part that differs from the ordinary GPL. If you
change MELRA and let other people use your changed version over a network, for
example through its HTTP MCP endpoint, its JSON API or its console, or inside a
hosted service they reach remotely, you must offer those people the complete
source code of your changed version, under the AGPL, free of charge, for
example with a download link they can see.

This does not apply when you run MELRA unchanged, or when you change it and
nobody but you uses it over a network. The source you must offer is that of
your changed MELRA: a separate program that only calls it, over MCP, the CLI or
the JSON API, or through the Apache-2.0 SDKs, is not part of it.

Giving someone a copy, such as a binary, a container image or a package,
carries the usual GPL duty to provide the source as well, whether or not you
changed it. If you are unsure which case you are in, ask your counsel, or ask
XAGI Labs about the commercial license.

## Name and logo

The code licenses grant no rights to the MELRA name or logo. See
[TRADEMARKS.md](TRADEMARKS.md).
