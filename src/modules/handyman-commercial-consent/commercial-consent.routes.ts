import { toHandymanBastCommandPayload } from '../handyman-bast-api/handyman-bast-api.controller';
import { findQuotationDecisionOffer } from '../handyman-quotations/handyman-quotation-document.service';
import { Router } from 'express';
import { withTransaction } from '../../database';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { acceptHandymanBast, rejectHandymanBast } from '../handyman-bast/handyman-bast.service';
import { handymanBastRepository } from '../handyman-bast/handyman-bast.repository';
import { recordNeutralCareCommunication } from '../handyman-care-communications/handyman-care-communications.service';
import { careCreateContextNotFound } from '../handyman-care-workspace/care-create-exchange.scope';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from '../handyman-care-workspace/care-workspace.service';
import { handymanServiceRequestRepository } from '../handyman-requests/handyman-service-request.repository';
import { handymanExecutionScopeRepository } from '../handyman-quotations/handyman-execution-scope.repository';
import { handymanQuotationRepository } from '../handyman-quotations/handyman-quotation.repository';
import { decideHandymanQuotation } from '../handyman-quotations/handyman-quotation-decision.service';
import { handymanScopeAssignmentRepository } from '../handyman-scope-assignments';
import { authorizeCareCommercialRequest, type CareDecisionChannel } from './commercial-consent.service';
import { bastCommercialTarget, quotationCommercialTarget } from './commercial-consent.targets';

const invalid = () => AppError.validation('Invalid Care commercial decision request.');
function id(value: string): string { if (!isValidUuid(value)) throw invalid(); return value.toLowerCase(); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

/** Existing workspace authentication, NO local customer User/session. The
 * receiver verifies a distinct customer-consent assertion in the ORIGINAL
 * decision transaction. No generic care-decisions approval engine exists. */
export function createCommercialConsentBridgeRouter(): Router {
  const router = Router();
  router.use('/handyman/care/requests/:requestId', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const token = (authorization: string | undefined) => {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!match) throw workspaceUnauthorized();
    return match[1];
  };
  router.post('/handyman/care/requests/:requestId/communications', async (req, res, next) => {
    try {
      if (Object.keys(req.query).length) throw invalid();
      const principal = await resolveCareWorkspacePrincipal(token(req.header('authorization')));
      const requestId = id(String(req.params.requestId));
      const result = await withTransaction(async tx => {
        const request = await handymanServiceRequestRepository.findById(tx, requestId);
        if (!request) throw careCreateContextNotFound();
        await authorizeCareCommercialRequest(tx, principal, request);
        return recordNeutralCareCommunication(tx, { clientId: request.clientId, buildingId: request.buildingId, requestId },
          { careActorId: principal.careActorId }, req.body);
      });
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId/commercial-targets/:targetType/:targetId', async (req, res, next) => {
    try {
      if (Object.keys(req.query).length || (req.body !== undefined && Object.keys(object(req.body)).length)) throw invalid();
      const principal = await resolveCareWorkspacePrincipal(token(req.header('authorization')));
      const requestId = id(String(req.params.requestId)), targetId = id(String(req.params.targetId));
      const kind = req.params.targetType;
      if (kind !== 'QUOTATION_VERSION' && kind !== 'BAST') throw invalid();
      const result = await withTransaction(async tx => {
        const request = await handymanServiceRequestRepository.findById(tx, requestId);
        if (!request) throw careCreateContextNotFound();
        if (kind === 'QUOTATION_VERSION') {
          const version = await handymanQuotationRepository.lockVersionById(tx, targetId);
          const quotation = version && await handymanQuotationRepository.findQuotationById(tx, version.quotationId);
          if (!version || !quotation || quotation.handymanRequestId !== request.id || quotation.clientId !== request.clientId) throw careCreateContextNotFound();
          await authorizeCareCommercialRequest(tx, principal, request);
          if (version.status !== 'ISSUED' || !version.validUntil || version.validUntil.getTime() <= Date.now()) throw invalid();
          const offer = await findQuotationDecisionOffer(tx, version.id);
          return { target: quotationCommercialTarget(version.id, request, offer), offer,
            customer: requestContext(request), validUntil: version.validUntil.toISOString() };
        }
        const parent = await handymanBastRepository.findBastById(tx, targetId);
        if (!parent) throw careCreateContextNotFound();
        await handymanScopeAssignmentRepository.lockScopeById(tx, parent.executionScopeId);
        const bast = await handymanBastRepository.findBastByIdForUpdate(tx, targetId);
        const scope = await handymanExecutionScopeRepository.findScopeById(tx, parent.executionScopeId);
        if (!bast || !scope || scope.handymanRequestId !== request.id || scope.clientId !== request.clientId) throw careCreateContextNotFound();
        await authorizeCareCommercialRequest(tx, principal, request);
        if (bast.status !== 'ISSUED') throw invalid();
        return { target: await bastCommercialTarget(tx, bast, scope), customer: requestContext(request), artifactRef: `BAST/${bast.id}/v2` };
      });
      sendSuccess(res, result);
    } catch (error) { next(error); }
  });
  for (const kind of ['quotation-versions', 'bast'] as const) {
    router.post(`/handyman/care/requests/:requestId/${kind}/:targetId/decision`, async (req, res, next) => {
      try {
        if (Object.keys(req.query).length) throw invalid();
        const b = object(req.body);
        if (Object.keys(b).some(k => !['decision', 'idempotencyKey', 'consentAssertion', 'rejectReason'].includes(k)) ||
            !['ACCEPT', 'REJECT'].includes(String(b.decision)) || typeof b.idempotencyKey !== 'string' ||
            (kind === 'quotation-versions' && b.rejectReason !== undefined) ||
            (b.rejectReason != null && (typeof b.rejectReason !== 'string' || b.rejectReason.trim() !== b.rejectReason || b.rejectReason.length > 2000))) throw invalid();
        const channel: CareDecisionChannel = { workspaceToken: token(req.header('authorization')),
          requestId: id(String(req.params.requestId)), assertion: b.consentAssertion,
          signature: req.header('x-handyman-commercial-consent-signature') };
        const targetId = id(String(req.params.targetId));
        const result = kind === 'quotation-versions'
          ? await decideHandymanQuotation(targetId, { decision: b.decision === 'ACCEPT' ? 'APPROVE' : 'REJECT', idempotencyKey: b.idempotencyKey }, channel)
          : await (b.decision === 'ACCEPT' ? acceptHandymanBast : rejectHandymanBast)(channel, {
            bastId: targetId, idempotencyKey: b.idempotencyKey, signatureDigest: '', rejectReason: b.rejectReason as string | null | undefined,
          });
        sendSuccess(res, 'bast' in result ? toHandymanBastCommandPayload(result) : result);
      } catch (error) { next(error); }
    });
  }
  return router;
}
function requestContext(r: { id: string; clientId: string; tenantCompanyId: string; tenantPicId: string | null; buildingId: string; spaceId: string | null }) {
  return { handymanRequestId: r.id, clientId: r.clientId, tenantCompanyId: r.tenantCompanyId,
    tenantPicId: r.tenantPicId, buildingId: r.buildingId, spaceId: r.spaceId };
}
