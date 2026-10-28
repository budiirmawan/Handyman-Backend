import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getHandymanBmSettlementDetail, listHandymanBmSettlements,
  prepareHandymanBmSettlement, supersedeHandymanBmSettlement, approveHandymanBmSettlement,
  recordHandymanBmSettlementPayment } from './handyman-bm-settlement.service';

const base = '/handyman/clients/:clientId/buildings/:buildingId/bm-settlements';
const readScope = requirePermission('handyman.finance.read');
const makerScope = [requirePermission('handyman.finance.manage'), requirePermission('handyman.settlement.manage')];
const PAYMENT_FIELDS = ['transferReference', 'amount', 'transferredAt', 'idempotencyKey'];
const settlementMissing = () => new AppError({
  code: ERROR_CODES.HANDYMAN_BM_SETTLEMENT_NOT_FOUND, statusCode: 404,
  message: 'BM settlement not found in this Client and Building.',
});
function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !allowed.includes(k))) {
    throw AppError.validation('Unexpected settlement action fields.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw AppError.validation(`Invalid ${field}.`);
  return value;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some(v => typeof v !== 'string')) {
    throw AppError.validation(`Invalid ${field}.`);
  }
  return value as string[];
}

/** Read-only Operations/Manager settlement contract: scoped, cursor-paginated
 *  list plus the authoritative detail projection. No write or action routes. */
export function createHandymanBmSettlementRouter(): Router {
  const router = Router();
  router.get(base, authenticationMiddleware, readScope,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).some(k => !['limit', 'after'].includes(k)) ||
            (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^[1-9][0-9]*$/.test(req.query.limit))) ||
            (req.query.after !== undefined && typeof req.query.after !== 'string')) {
          throw AppError.validation('Invalid settlement list query.');
        }
        const result = await listHandymanBmSettlements(req.auth.userId, {
          clientId: req.params.clientId as string, buildingId: req.params.buildingId as string,
          ...(req.query.limit === undefined ? {} : { limit: Number(req.query.limit) }),
          ...(req.query.after === undefined ? {} : { after: req.query.after as string }),
        });
        res.json({ data: result });
      } catch (error) { next(error); }
    });
  router.get(`${base}/:settlementId`, authenticationMiddleware, readScope,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
        const detail = await getHandymanBmSettlementDetail(req.auth.userId, {
          clientId: req.params.clientId as string, buildingId: req.params.buildingId as string,
          settlementId: req.params.settlementId as string,
        });
        res.json({ data: detail });
      } catch (error) { next(error); }
    });
  // CR-HM-BM-SETTLEMENT-API-01 PART 01B-1 — exactly two scoped write actions,
  // thin over the existing services: their validation, locks, idempotency and
  // audit identity are the single source of truth. The path Client/Building
  // is resolved against the authoritative entitlement/settlement before the
  // service runs, so the URI scope is never merely decorative.
  router.post(base, authenticationMiddleware, ...makerScope,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
        const clientId = req.params.clientId as string, buildingId = req.params.buildingId as string;
        const b = body(req.body, ['entitlementId', 'ledgerEntryIds', 'bankVersionId', 'idempotencyKey', 'evidenceReference']);
        const entitlementId = text(b.entitlementId, 'entitlementId');
        if (!isValidUuid(clientId) || !isValidUuid(entitlementId)) throw AppError.validation('Invalid settlement scope.');
        const scope = (await getPool().query<{ building_id: string }>(`SELECT x.building_id
          FROM handyman_entitlement_facts f
          JOIN handyman_execution_scopes x ON x.id=f.execution_scope_id AND x.client_id=f.client_id
          WHERE f.id=$1 AND f.client_id=$2 AND f.entitlement_kind='BM_FEE'`,
          [entitlementId, clientId])).rows[0];
        if (!scope || scope.building_id !== buildingId) throw settlementMissing();
        const result = await prepareHandymanBmSettlement(req.auth.userId, {
          clientId, entitlementId, ledgerEntryIds: strings(b.ledgerEntryIds, 'ledgerEntryIds'),
          bankVersionId: text(b.bankVersionId, 'bankVersionId'),
          idempotencyKey: text(b.idempotencyKey, 'idempotencyKey'),
          evidenceReference: text(b.evidenceReference, 'evidenceReference'),
        });
        res.status(result.replayed ? 200 : 201).json({ data: result });
      } catch (error) { next(error); }
    });
  router.post(`${base}/:settlementId/supersede`, authenticationMiddleware, ...makerScope,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
        const clientId = req.params.clientId as string, buildingId = req.params.buildingId as string,
          settlementId = req.params.settlementId as string;
        if (!isValidUuid(clientId) || !isValidUuid(settlementId)) throw AppError.validation('Invalid settlement scope.');
        const b = body(req.body, ['supersessionReason', 'ledgerEntryIds', 'bankVersionId', 'idempotencyKey', 'evidenceReference']);
        const row = (await getPool().query<{ building_id: string }>(
          'SELECT building_id FROM handyman_bm_settlements WHERE id=$1 AND client_id=$2',
          [settlementId, clientId])).rows[0];
        if (!row || row.building_id !== buildingId) throw settlementMissing();
        const result = await supersedeHandymanBmSettlement(req.auth.userId, {
          clientId, settlementId, supersessionReason: text(b.supersessionReason, 'supersessionReason'),
          ledgerEntryIds: strings(b.ledgerEntryIds, 'ledgerEntryIds'),
          bankVersionId: text(b.bankVersionId, 'bankVersionId'),
          idempotencyKey: text(b.idempotencyKey, 'idempotencyKey'),
          evidenceReference: text(b.evidenceReference, 'evidenceReference'),
        });
        res.status(result.replayed ? 200 : 201).json({ data: result });
      } catch (error) { next(error); }
    });
  // CR-HM-BM-SETTLEMENT-API-01 PART 01B-2 — independent Manager/Finance
  // approval: thin over approveHandymanBmSettlement, which enforces the
  // maker-checker split, digest/currentness (fresh anchors, non-superseded)
  // and approval replay inside the same transaction. Nothing else moves:
  // approval never records a transfer or advances status past APPROVED.
  router.post(`${base}/:settlementId/approve`, authenticationMiddleware,
    requirePermission('handyman.finance.read'), requirePermission('handyman.bm_settlement.approve'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
        const clientId = req.params.clientId as string, buildingId = req.params.buildingId as string,
          settlementId = req.params.settlementId as string;
        if (!isValidUuid(clientId) || !isValidUuid(settlementId)) throw AppError.validation('Invalid settlement scope.');
        const b = body(req.body, ['settlementDigest', 'evidenceReference']);
        const row = (await getPool().query<{ building_id: string }>(
          'SELECT building_id FROM handyman_bm_settlements WHERE id=$1 AND client_id=$2',
          [settlementId, clientId])).rows[0];
        if (!row || row.building_id !== buildingId) throw settlementMissing();
        const result = await approveHandymanBmSettlement(req.auth.userId, {
          clientId, settlementId, settlementDigest: text(b.settlementDigest, 'settlementDigest'),
          evidenceReference: text(b.evidenceReference, 'evidenceReference'),
        });
        res.status(result.replayed ? 200 : 201).json({ data: result });
      } catch (error) { next(error); }
    });
  // CR-HM-BM-SETTLEMENT-API-01 PART 01B-3 — record actual outgoing transfer
  // evidence over HTTP, thin over recordHandymanBmSettlementPayment: the
  // service alone validates the approved settlement, exact net payable,
  // pinned approved beneficiary, approval-time window, idempotent replay
  // and duplicate payouts. Evidence arrives as multipart form-data (field
  // "file", ≤10 MB) or a JSON file.contentBase64 object, mirroring the
  // payment-proof upload convention. Recording returns PAYMENT_RECORDED
  // only — verification and SETTLED stay a separate authorized action.
  router.post(`${base}/:settlementId/payments`, authenticationMiddleware, ...makerScope,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
        const clientId = req.params.clientId as string, buildingId = req.params.buildingId as string,
          settlementId = req.params.settlementId as string;
        if (!isValidUuid(clientId) || !isValidUuid(settlementId)) throw AppError.validation('Invalid settlement scope.');
        const multipart = String(req.headers['content-type'] ?? '').startsWith('multipart/form-data');
        let file: { buffer: Buffer; mimeType: string };
        let fields: Record<string, unknown>;
        if (multipart) {
          const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
          await new Promise<void>((resolve, reject) => {
            upload.single('file')(req, res, error => {
              if (error) reject(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
                ? AppError.validation('Payout evidence exceeds the 10 MB limit.')
                : AppError.validation('Payout evidence upload failed.'));
              else if (!(req as typeof req & { file?: Express.Multer.File }).file)
                reject(AppError.validation('Multipart field "file" is required.'));
              else resolve();
            });
          });
          const uploaded = (req as typeof req & { file: Express.Multer.File }).file;
          file = { buffer: uploaded.buffer, mimeType: uploaded.mimetype };
          fields = (req.body ?? {}) as Record<string, unknown>;
        } else {
          const b = body(req.body, [...PAYMENT_FIELDS, 'file']);
          const f = b.file;
          if (!f || typeof f !== 'object' || Array.isArray(f) ||
              typeof (f as Record<string, unknown>).contentBase64 !== 'string') {
            throw AppError.validation('A file with contentBase64 and mimeType is required.');
          }
          const fo = f as Record<string, unknown>;
          file = { buffer: Buffer.from(String(fo.contentBase64), 'base64'),
            mimeType: typeof fo.mimeType === 'string' ? fo.mimeType : '' };
          fields = b;
        }
        if (multipart && Object.keys(fields).some(k => !PAYMENT_FIELDS.includes(k))) {
          throw AppError.validation('Unexpected settlement payout fields.');
        }
        // Exact Client/Building path scope against the authoritative row.
        const row = (await getPool().query<{ building_id: string }>(
          'SELECT building_id FROM handyman_bm_settlements WHERE id=$1 AND client_id=$2',
          [settlementId, clientId])).rows[0];
        if (!row || row.building_id !== buildingId) throw settlementMissing();
        const result = await recordHandymanBmSettlementPayment(req.auth.userId, {
          clientId, settlementId,
          transferReference: text(fields.transferReference, 'transferReference'),
          amount: text(fields.amount, 'amount'),
          transferredAt: text(fields.transferredAt, 'transferredAt'),
          idempotencyKey: text(fields.idempotencyKey, 'idempotencyKey'),
          file,
        });
        res.status(result.replayed ? 200 : 201).json({ data: result });
      } catch (error) { next(error); }
    });
  return router;
}
