/**
 * CR-HM-07 Arrival Verification PART 01 — arrival challenge types.
 * Bounded lifecycle ONLY: PENDING -> CONSUMED (single use,
 * server consumes) or PENDING -> EXPIRED (server TTL pass). A
 * CONSUMED challenge means its token was consumed once — it is
 * NEVER an arrival VERIFIED result (no outcome semantics exist in
 * PART 01).
 */
export const HANDYMAN_ARRIVAL_CHALLENGE_STATUSES =
  ['PENDING', 'CONSUMED', 'EXPIRED'] as const;

export type HandymanArrivalChallengeStatus =
  (typeof HANDYMAN_ARRIVAL_CHALLENGE_STATUSES)[number];

/** Frozen TTL: server-set, caller can never influence. */
export const HANDYMAN_ARRIVAL_CHALLENGE_TTL_SECONDS = 120;

export interface HandymanArrivalChallengeRecord {
  id: string;
  clientId: string;
  executionScopeId: string;
  assignmentId: string;
  actorUserId: string;
  tokenHash: string;
  status: HandymanArrivalChallengeStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewHandymanArrivalChallenge {
  clientId: string;
  executionScopeId: string;
  assignmentId: string;
  actorUserId: string;
  tokenHash: string;
}

/** Public shape: serialized, and tokenHash NEVER leaves storage. */
export interface PublicHandymanArrivalChallenge {
  id: string;
  clientId: string;
  executionScopeId: string;
  assignmentId: string;
  actorUserId: string;
  status: HandymanArrivalChallengeStatus;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creation result: the RAW token is returned exactly once, at this
 * boundary only. It is never stored, logged, or journaled.
 */
export interface HandymanArrivalChallengeCreateResult {
  challenge: PublicHandymanArrivalChallenge;
  token: string;
}

/** Caller authority surface: the target ONLY. Nothing else is read. */
export interface CreateHandymanArrivalChallengeInput {
  executionScopeId: string;
}

/** Internal consume primitive input (token comparison server-side). */
export interface ConsumeHandymanArrivalChallengeInput {
  challengeId: string;
  token: string;
}
