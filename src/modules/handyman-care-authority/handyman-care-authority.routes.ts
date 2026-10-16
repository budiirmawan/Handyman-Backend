import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { sendSuccess } from '../../shared/api-response';
import { resolveBuildingCareAuthority } from './handyman-care-authority.service';
import {
  NON_ACCEPTED_IDENTITY_FIELDS,
  HANDYMAN_CARE_BUILDING_PERMISSION,
} from './handyman-care-authority.service';
import {
  assertNoSuppliedRecordingIdentity,
  parseBuildingIdParam,
  parseOptionalClientIdParam,
} from './handyman-care-authority.validation';

/**
 * CR-HM-BM-CARE-AUTH-01 — Building Customer Care authority transport
 * (Authority A).
 *
 *   GET /handyman/care/buildings/:buildingId/authority
 *
 * A READ-ONLY surface. It answers exactly two questions and nothing else:
 * who is the authenticated Building Customer Care actor, and may they mediate
 * this exact Building.
 *
 * Deliberately absent:
 *   - POST /handyman/care-decisions — Authority B, BLOCKED. Not registered
 *     here (or anywhere), so it 404s. It stays absent until the commercial
 *     decision authority and the verified evidence contract are both
 *     sufficient. RBAC working is not a reason to activate it.
 *   - Any quotation / variation / BAST mutation. This router registers a
 *     single GET and nothing else, so no commercial state can be written
 *     through the Care bridge (SD-17: neutral recording, no automatic
 *     commercial mutations).
 *
 * Every request: authentication (session) → the dedicated
 * `handyman.care.building` capability → the Authority A resolver (ACTIVE
 * account, ACTIVE assignment to the EXACT Building, server-derived Client).
 * The actor is ALWAYS `req.auth.userId`; no request field can name another
 * actor (SD-19), and presenting one is rejected rather than ignored.
 */

export function createHandymanCareAuthorityRouter(): Router {
  const router = Router();

  router.get(
    '/handyman/care/buildings/:buildingId/authority',
    authenticationMiddleware,
    // Layer 1 — the dedicated Care capability (migration 0450, granted to NO
    // role by default). Layer 2 is the same check inside the resolver, so the
    // authority holds even when the resolver is reused outside this router.
    // Generic `tenant_company.manage` is never accepted here.
    requirePermission(HANDYMAN_CARE_BUILDING_PERMISSION),
    async (req, res, next) => {
      try {
        const buildingId = parseBuildingIdParam(req.params.buildingId);
        const assertedClientId = parseOptionalClientIdParam(
          typeof req.query.clientId === 'string' ? req.query.clientId : null,
        );

        // SD-19 — reject any browser-supplied recording identity.
        assertNoSuppliedRecordingIdentity(NON_ACCEPTED_IDENTITY_FIELDS, [
          req.query as Record<string, unknown>,
          req.body as Record<string, unknown> | undefined,
        ]);

        const authority = await resolveBuildingCareAuthority({
          actorUserId: req.auth?.userId,
          buildingId,
          assertedClientId,
        });

        sendSuccess(res, authority, 200, {
          grantedByPermission: HANDYMAN_CARE_BUILDING_PERMISSION,
          authorityModel: 'A',
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
