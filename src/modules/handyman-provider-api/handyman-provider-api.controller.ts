import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../handyman-providers';
import {
  parseCrewLeadBody,
  parseCrewMemberBody,
  parseCrewMembershipStatusBody,
  parseProviderApiUuidParam,
  parseProviderContextCreateBody,
  parseProviderContextStatusBody,
  parseWorkerContextCreateBody,
  parseWorkerContextStatusBody,
  parseWorkCrewCreateBody,
  parseWorkCrewStatusBody,
} from './handyman-provider-api.validation';

/**
 * CR-HM-04 PART 05A — Handyman provider/worker/crew HTTP handlers
 * (FROZEN F9).
 *
 * Thin shells only: URL ids + whitelisted body + authenticated actor from
 * `req.auth.userId`. The PART 01–03 services remain the sole authority
 * for Client-scope derivation, provider/vendor relationship validation,
 * login-less helper admission, Lead eligibility (linked login identity),
 * Lead/member/provider invariants and append-only journal — no business
 * rule exists in this layer, and HTTP never duplicates a service rule.
 *
 * Assignment is NOT part of this surface: PART 04 target binding is
 * deferred to the authoritative CR-HM-06 target authority, so no
 * assignment route exists here.
 */

const p = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

/** POST /handyman/provider-contexts — create over an existing `vendors` row. */
export async function postHandymanProviderContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseProviderContextCreateBody(req.body);
    const record = await handymanProviderContextService
      .createHandymanProviderContext(input, req.auth.userId);
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/provider-contexts/by-vendor/:vendorId — bounded existing read. */
export async function getHandymanProviderContextByVendorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseProviderApiUuidParam(p(req.params.vendorId), 'vendorId');
    const record = await handymanProviderContextService
      .getHandymanProviderContextByVendor(vendorId, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/provider-contexts/:providerContextId/status */
export async function postHandymanProviderContextStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const providerContextId = parseProviderApiUuidParam(
      p(req.params.providerContextId),
      'providerContextId',
    );
    const status = parseProviderContextStatusBody(req.body);
    const record = await handymanProviderContextService
      .setHandymanProviderContextStatus(providerContextId, status, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/worker-contexts — provider context + workforce profile refs. */
export async function postHandymanWorkerContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseWorkerContextCreateBody(req.body);
    const record = await handymanWorkerContextService
      .createHandymanWorkerContext(input, req.auth.userId);
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/worker-contexts/:workerContextId — bounded existing read. */
export async function getHandymanWorkerContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workerContextId = parseProviderApiUuidParam(
      p(req.params.workerContextId),
      'workerContextId',
    );
    const record = await handymanWorkerContextService
      .getHandymanWorkerContext(workerContextId, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/worker-contexts/:workerContextId/status */
export async function postHandymanWorkerContextStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workerContextId = parseProviderApiUuidParam(
      p(req.params.workerContextId),
      'workerContextId',
    );
    const status = parseWorkerContextStatusBody(req.body);
    const record = await handymanWorkerContextService
      .setHandymanWorkerContextStatus(workerContextId, status, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/work-crews — transactional create with initial valid Lead. */
export async function postHandymanWorkCrewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseWorkCrewCreateBody(req.body);
    const bundle = await handymanWorkCrewService
      .createHandymanWorkCrew(input, req.auth.userId);
    sendSuccess(res, bundle, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/work-crews/:crewId — crew + memberships + current Lead. */
export async function getHandymanWorkCrewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseProviderApiUuidParam(p(req.params.crewId), 'crewId');
    const bundle = await handymanWorkCrewService
      .getHandymanWorkCrew(crewId, req.auth.userId);
    sendSuccess(res, bundle, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/work-crews/:crewId/status */
export async function postHandymanWorkCrewStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseProviderApiUuidParam(p(req.params.crewId), 'crewId');
    const status = parseWorkCrewStatusBody(req.body);
    const record = await handymanWorkCrewService
      .setHandymanWorkCrewStatus(crewId, status, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/work-crews/:crewId/members — add a member (helper allowed). */
export async function postHandymanCrewMemberHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseProviderApiUuidParam(p(req.params.crewId), 'crewId');
    const input = parseCrewMemberBody(req.body);
    const record = await handymanWorkCrewService
      .addHandymanCrewMember({ ...input, handymanCrewId: crewId }, req.auth.userId);
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/work-crews/:crewId/lead — designate/change the current Lead. */
export async function postHandymanCrewLeadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseProviderApiUuidParam(p(req.params.crewId), 'crewId');
    const input = parseCrewLeadBody(req.body);
    const record = await handymanWorkCrewService
      .designateHandymanCrewLead({ ...input, handymanCrewId: crewId }, req.auth.userId);
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/crew-memberships/:membershipId/status */
export async function postHandymanCrewMembershipStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const membershipId = parseProviderApiUuidParam(
      p(req.params.membershipId),
      'membershipId',
    );
    const status = parseCrewMembershipStatusBody(req.body);
    const record = await handymanWorkCrewService
      .setHandymanCrewMemberStatus(membershipId, status, req.auth.userId);
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}
