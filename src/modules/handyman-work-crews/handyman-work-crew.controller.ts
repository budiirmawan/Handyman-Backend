import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { handymanWorkCrewService } from './handyman-work-crew.service';
import {
  assertEmptyHandymanWorkCrewCommandBody,
  parseAddHandymanWorkCrewMemberHttpBody,
  parseChangeHandymanWorkCrewLeadHttpBody,
  parseCreateHandymanWorkCrewHttpBody,
  parseHandymanWorkCrewIdParam,
  parseHandymanWorkCrewMemberIdParam,
  parseListHandymanWorkCrewMembersHttpQuery,
  parseListHandymanWorkCrewsHttpQuery,
  parseUpdateHandymanWorkCrewHttpBody,
} from './handyman-work-crew.validation';

/**
 * CR-HM-BE-04 RUN 2 — Thin HTTP handlers for the Handyman Work Crew contract.
 * ALL authority lives in the Run-1 crew service: client access, provider
 * designation validity, vendor relationship, worker binding/EXTERNAL-profile
 * validation, the lead invariant, lifecycle guards, and concurrency. These
 * handlers only parse governed inputs (strict allowlists), derive the actor
 * from the authenticated session (never from the body), and delegate. The
 * atomic lead replacement calls the single Run-1 command — no
 * remove-then-add composition happens here. Errors flow to the shared
 * Express error pipeline via `next(error)`.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createHandymanWorkCrewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseCreateHandymanWorkCrewHttpBody(req.body);
    const result = await handymanWorkCrewService.createHandymanWorkCrewForProvider(
      body.handymanProviderId,
      {
        crewCode: body.crewCode,
        crewName: body.crewName,
        leadWorkerBindingId: body.leadWorkerBindingId,
      },
      actor(req),
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanWorkCrewsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseListHandymanWorkCrewsHttpQuery(req.query);
    const crews = await handymanWorkCrewService.listHandymanWorkCrews(
      query.clientId,
      actor(req),
      {
        ...(query.handymanProviderId
          ? { handymanProviderId: query.handymanProviderId }
          : {}),
        ...(query.status ? { status: query.status } : {}),
      },
    );
    sendSuccess(res, crews);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanWorkCrewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseHandymanWorkCrewIdParam(param(req.params.crewId));
    const crew = await handymanWorkCrewService.getHandymanWorkCrewById(
      crewId,
      actor(req),
    );
    sendSuccess(res, crew);
  } catch (error) {
    next(error);
  }
}

export async function updateHandymanWorkCrewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseHandymanWorkCrewIdParam(param(req.params.crewId));
    const body = parseUpdateHandymanWorkCrewHttpBody(req.body);
    const crew = await handymanWorkCrewService.updateHandymanWorkCrew(
      crewId,
      { crewName: body.crewName },
      actor(req),
    );
    sendSuccess(res, crew);
  } catch (error) {
    next(error);
  }
}

export async function deactivateHandymanWorkCrewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseHandymanWorkCrewIdParam(param(req.params.crewId));
    assertEmptyHandymanWorkCrewCommandBody(req.body);
    const crew = await handymanWorkCrewService.updateHandymanWorkCrewStatus(
      crewId,
      { status: 'INACTIVE' },
      actor(req),
    );
    sendSuccess(res, crew);
  } catch (error) {
    next(error);
  }
}

export async function activateHandymanWorkCrewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseHandymanWorkCrewIdParam(param(req.params.crewId));
    assertEmptyHandymanWorkCrewCommandBody(req.body);
    const crew = await handymanWorkCrewService.updateHandymanWorkCrewStatus(
      crewId,
      { status: 'ACTIVE' },
      actor(req),
    );
    sendSuccess(res, crew);
  } catch (error) {
    next(error);
  }
}

export async function addHandymanWorkCrewMemberHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseHandymanWorkCrewIdParam(param(req.params.crewId));
    const body = parseAddHandymanWorkCrewMemberHttpBody(req.body);
    const member = await handymanWorkCrewService.addHandymanWorkCrewMember(
      crewId,
      {
        vendorWorkforceBindingId: body.vendorWorkforceBindingId,
        crewRole: body.crewRole,
      },
      actor(req),
    );
    sendSuccess(res, member, 201);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanWorkCrewMembersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseHandymanWorkCrewIdParam(param(req.params.crewId));
    const query = parseListHandymanWorkCrewMembersHttpQuery(req.query);
    const members = await handymanWorkCrewService.listHandymanWorkCrewMembers(
      crewId,
      actor(req),
      query.status ? { status: query.status } : {},
    );
    sendSuccess(res, members);
  } catch (error) {
    next(error);
  }
}

export async function removeHandymanWorkCrewMemberHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseHandymanWorkCrewIdParam(param(req.params.crewId));
    const memberId = parseHandymanWorkCrewMemberIdParam(
      param(req.params.memberId),
    );
    assertEmptyHandymanWorkCrewCommandBody(req.body);
    const member = await handymanWorkCrewService.removeHandymanWorkCrewMember(
      crewId,
      memberId,
      actor(req),
    );
    sendSuccess(res, member);
  } catch (error) {
    next(error);
  }
}

export async function changeHandymanWorkCrewLeadWorkerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewId = parseHandymanWorkCrewIdParam(param(req.params.crewId));
    const body = parseChangeHandymanWorkCrewLeadHttpBody(req.body);
    // The Run-1 ATOMIC replacement command — the controller never composes
    // remove-old-then-add-new itself.
    const result = await handymanWorkCrewService.changeHandymanWorkCrewLeadWorker(
      crewId,
      { newLeadWorkerBindingId: body.newLeadWorkerBindingId },
      actor(req),
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
