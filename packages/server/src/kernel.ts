// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

// `@melra/server/kernel`: the runtime and what describes it, without the MCP
// and HTTP interfaces, which load the MCP SDK and its JSON Schema stack. The
// CLI used to load those for every command, `melra version` included (#368).
export * from "./approval-screen.js";
export * from "./oauth.js";
export * from "./runtime.js";
// Writing an `evidenceVerifiers` entry needs these, without a direct
// dependency on @melra/verifier-core.
export type {
  PredicateVerifier,
  RegisteredVerifier,
  VerificationContext,
} from "@melra/verifier-core";
