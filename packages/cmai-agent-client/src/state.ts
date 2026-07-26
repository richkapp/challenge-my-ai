import type { CmaiAgentClientPhase } from "./types";
import { clientStateError } from "./errors";

const allowedTransitions = {
  unpaired: ["paired"],
  paired: ["challenge_ready", "revoked"],
  challenge_ready: ["challenge_ready", "preview", "revoked"],
  preview: ["preview", "submitting", "discarded", "challenge_ready", "revoked"],
  submitting: ["submitted", "submit_failed", "revoked"],
  submit_failed: ["submitting", "discarded", "challenge_ready", "revoked"],
  submitted: ["challenge_ready", "revoked"],
  discarded: ["challenge_ready", "revoked"],
  revoked: ["paired"],
} as const satisfies Record<CmaiAgentClientPhase, readonly CmaiAgentClientPhase[]>;

export function assertCmaiAgentClientTransition(
  current: CmaiAgentClientPhase,
  next: CmaiAgentClientPhase,
): void {
  const allowed = allowedTransitions[current] as readonly CmaiAgentClientPhase[];
  if (!allowed.includes(next)) {
    throw clientStateError(`Cannot transition the CMAI Agent client from ${current} to ${next}.`);
  }
}
