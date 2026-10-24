import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  createHandymanArrivalChallenge,
} from '../handyman-arrival-challenges';
import { isValidUuid } from '../clients';
import { AppError } from '../../shared/errors';
import type { ArrivalChallengeIssuedResponse }
  from './handyman-arrival-challenge-api.types';

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 02 — arrival challenge ISSUANCE handler
 * (THIN shell, exactly one responsibility).
 *
 * The handler does exactly: auth/context → bounded scope-param
 * validation → the pre-existing CR-HM-07 PART 01 issuer → bounded
 * serialization. It holds ZERO decision logic: the AUTHORIZED scope
 * gate, BE-02G exact-Building access, CR-HM-04 CURRENT Crew Lead
 * resolution, declined-assignment refusal, TTL and the one-live-PENDING
 * rule all stay inside `createHandymanArrivalChallenge`.
 *
 * This is deliberately a SEPARATE exposure module from
 * `handyman-arrival-verification-api` (CR-HM-07 PART 04C), whose
 * certification forbids that module from importing the challenge
 * authority. Issuance and terminal verification stay distinct shells
 * over distinct authorities; neither duplicates the other.
 *
 * The raw token crosses this response EXACTLY ONCE. Internal binding
 * ids (clientId / assignmentId / actorUserId) and the token hash are
 * never projected.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function parseScopeParam(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!isValidUuid(raw)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'executionScopeId',
        message: 'executionScopeId must be a valid UUID.',
      },
    ]);
  }
  return raw;
}

export async function postHandymanArrivalChallengeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseScopeParam(p(req.params.executionScopeId));
    // The request body is NEVER read: the scope is the only caller input
    // and the actor comes from `req.auth`. Unknown/authority-shaped body
    // keys are therefore structurally ignored.
    const issued = await createHandymanArrivalChallenge(
      { executionScopeId },
      actor(req),
    );
    const body: ArrivalChallengeIssuedResponse = {
      id: issued.challenge.id,
      executionScopeId: issued.challenge.executionScopeId,
      // The PART 01 issuer inserts under the one-live-PENDING index, so a
      // freshly issued challenge is always PENDING.
      status: 'PENDING',
      expiresAt: issued.challenge.expiresAt,
      challengeToken: issued.token,
    };
    sendSuccess(res, body, 201);
  } catch (error) {
    next(error);
  }
}
