// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

// Imported by `bin.ts` before the rest of the CLI, so it must not import
// anything that links `node:sqlite`.

/** Whether a Node.js version is one `node:sqlite` loads on without a flag: `^22.13.0 || >=23.4.0`. */
export function sqliteShipsWith(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24;
}

/** What `melra` prints, and exits on, when `node:sqlite` cannot be loaded. */
export function sqliteUnavailable(version: string): string {
  return sqliteShipsWith(version)
    ? `melra: Node.js ${version} has node:sqlite turned off or built without it; check NODE_OPTIONS for --no-experimental-sqlite`
    : `melra: Node.js ${version} cannot load node:sqlite; use Node.js 22.13 or newer, or 23.4 or newer`;
}
