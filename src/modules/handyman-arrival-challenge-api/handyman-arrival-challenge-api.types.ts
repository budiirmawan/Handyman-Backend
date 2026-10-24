/**
 * CR-HM-FIELD-OPS-ACK-01 PART 02 — bounded issuance projection.
 *
 * Exactly the fields the mobile client needs to run the terminal
 * CR-HM-07 PART 04C command. Deliberately absent: `clientId`,
 * `assignmentId`, `actorUserId` (internal binding) and any token-hash
 * or provider material.
 */
export type ArrivalChallengeIssuedResponse = {
  id: string;
  executionScopeId: string;
  status: 'PENDING';
  expiresAt: string;
  challengeToken: string;
};
