import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { permitEvidenceService } from './permit-evidence.service';
import {
  parseCreatePermitEvidenceRequirementBody,
  parsePermitEvidenceFilters,
  parsePermitEvidenceIdParam,
  parsePermitEvidencePermitIdParam,
  parseSubmitPermitEvidenceBody,
} from './permit-evidence.validation';
const param=(v:string|string[]|undefined)=>Array.isArray(v)?v[0]??'':v??'';
function actor(req:Request){if(!req.auth)throw authenticationRequiredError();return req.auth.userId}
export async function createRequirementHandler(q:Request,r:Response,n:NextFunction){try{sendSuccess(r,await permitEvidenceService.createPermitEvidenceRequirement(parsePermitEvidencePermitIdParam(param(q.params.permitId)),parseCreatePermitEvidenceRequirementBody(q.body),actor(q)),201)}catch(e){n(e)}}
export async function listRequirementsHandler(q:Request,r:Response,n:NextFunction){try{sendSuccess(r,await permitEvidenceService.resolvePermitEvidenceRequirements(parsePermitEvidencePermitIdParam(param(q.params.permitId)),actor(q)))}catch(e){n(e)}}
export async function submitEvidenceHandler(q:Request,r:Response,n:NextFunction){try{sendSuccess(r,await permitEvidenceService.submitPermitEvidence(parsePermitEvidencePermitIdParam(param(q.params.permitId)),parseSubmitPermitEvidenceBody(q.body),actor(q)),201)}catch(e){n(e)}}
export async function listEvidenceHandler(q:Request,r:Response,n:NextFunction){try{sendSuccess(r,await permitEvidenceService.listPermitEvidence(parsePermitEvidencePermitIdParam(param(q.params.permitId)),actor(q)))}catch(e){n(e)}}
export async function readinessHandler(q:Request,r:Response,n:NextFunction){try{sendSuccess(r,await permitEvidenceService.validatePermitEvidenceReadiness(parsePermitEvidencePermitIdParam(param(q.params.permitId)),actor(q)))}catch(e){n(e)}}
export async function getEvidenceHandler(q:Request,r:Response,n:NextFunction){try{sendSuccess(r,await permitEvidenceService.getPermitEvidence(parsePermitEvidenceIdParam(param(q.params.id)),actor(q)))}catch(e){n(e)}}
export async function listEvidenceByFiltersHandler(q:Request,r:Response,n:NextFunction){try{sendSuccess(r,await permitEvidenceService.listPermitEvidenceByFilters(parsePermitEvidenceFilters(q.query),actor(q)))}catch(e){n(e)}}
export async function removeEvidenceHandler(q:Request,r:Response,n:NextFunction){try{sendSuccess(r,await permitEvidenceService.removePermitEvidence(parsePermitEvidenceIdParam(param(q.params.id)),actor(q)))}catch(e){n(e)}}
