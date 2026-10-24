# @melra/browser-runtime

Playwright-backed browser control for
[MELRA](https://github.com/XAGI-Lab/melra), with the destination checks that
make it safe to point at a URL an agent chose.

```bash
npm install @melra/browser-runtime
```

```ts
import { BrowserRuntime } from "@melra/browser-runtime";
import { assertSafeUrl } from "@melra/policy-core";
```

Nineteen actions: navigate, back, forward, reload, inspect, wait, click, type,
fill_form, select, press, scroll, screenshot, upload, download, tabs, tab_new,
tab_switch, and close.

## The destination boundary

`assertSafeUrl` is the actual control, and it runs on every navigation:

- non-`http(s)` protocols are rejected, so `file://` cannot read the disk
- URLs carrying credentials are rejected
- DNS is resolved first, then **every** resolved address is checked — so a public
  hostname that resolves to a private address is refused rather than rebound
- private, loopback, link-local, and cloud-metadata ranges are blocked, IPv4 and
  IPv6, including IPv4-mapped IPv6 forms, and so is any IPv6 address outside
  global unicast that is not the IPv4-mapped or NAT64 form of a public IPv4
  address

A domain allowlist narrows this further, but the allowlist is not what makes it
safe — the address checks are, and they hold even with `allowedDomains: ["*"]`.

Downloads and uploads stay inside the workspace root. Screenshots and HAR
recordings are written where you point them, and are the one place page content
leaves the browser, so treat them as sensitive artifacts.

`unhinged: true` disables every check above except URL syntax. That includes the
cloud-metadata block, which is the check most likely to matter on a hosted
machine. A `reserved` callback, which the MELRA server always passes, still
refuses uploading a path it names or loading one through a `file:` URL, in
every mode. The server's callback names MELRA's data directory, the policy
file, the profile, the HAR files and credential files, but leaves its
artifacts (screenshots and downloads) readable, so the browser can use them
again.

Requires Node.js 22 or newer, and a Chromium that Playwright can launch. Full
documentation: [github.com/XAGI-Lab/melra](https://github.com/XAGI-Lab/melra)

Apache-2.0
