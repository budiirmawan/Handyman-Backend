import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getCrewCompetencyEligibilityHandler,
  listCompetencyCandidatesHandler,
} from './worker-competency-eligibility.controller';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — competency eligibility reads.
 *
 *   GET /handyman/execution-scopes/:executionScopeId/competency/eligibility?crewId=
 *   GET /handyman/execution-scopes/:executionScopeId/competency/candidates
 *
 * Both are READ-ONLY sub-resources of the EXISTING execution scope: the answer
 * is "would the assignment authority accept this crew right now", not a second
 * assignment model. The `competency` namespace is used (instead of a
 * `/assignment/*` sub-path) precisely so the frozen CR-HM-04 PART C invariant
 * "exactly two assignment URL shapes" stays literally true — this CR adds
 * explanation, never an alternative way to assign.
 *
 * Permissions: `tenant_company.read`, exactly like
 * `GET .../assignment`. Mutations still require `tenant_company.manage` on the
 * assignment routes, and the competency verdict cannot be used to bypass them —
 * it only explains what the assignment authority will decide.
 *
 * No write, no override flag, no "force" parameter exists here: a caller that
 * wants to assign an ineligible crew has to fix the evidence, not flip a flag.
 */
export function createWorkerCompetencyEligibilityRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const base = '/handyman/execution-scopes/:executionScopeId/competency';

  router.get(`${base}/eligibility`, auth, read, getCrewCompetencyEligibilityHandler);
  router.get(`${base}/candidates`, auth, read, listCompetencyCandidatesHandler);

  return router;
}
