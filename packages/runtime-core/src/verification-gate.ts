// Copyright 2024-2026 XAGI Labs Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

export type ToolEffect = "read" | "mutate";

export interface ToolObservation {
  name: string;
  effect: ToolEffect;
  structuredVerification?: boolean;
  expectationProvided?: boolean;
}

export interface VerificationGateState {
  mutated: boolean;
  verifiedAfterMutation: boolean;
  prompted: boolean;
  lastMutator?: string;
}

export function createVerificationGateState(): VerificationGateState {
  return {
    mutated: false,
    verifiedAfterMutation: false,
    prompted: false,
  };
}

export function observeToolCall(
  state: VerificationGateState,
  observation: ToolObservation,
): void {
  if (observation.effect === "mutate") {
    state.mutated = true;
    state.verifiedAfterMutation = false;
    state.lastMutator = observation.name;
    return;
  }
  if (
    state.mutated &&
    observation.structuredVerification === true &&
    observation.expectationProvided === true
  ) {
    state.verifiedAfterMutation = true;
  }
}

export function requiresVerification(state: VerificationGateState): boolean {
  return state.mutated && !state.verifiedAfterMutation && !state.prompted;
}

export function markVerificationPrompted(state: VerificationGateState): void {
  state.prompted = true;
}
