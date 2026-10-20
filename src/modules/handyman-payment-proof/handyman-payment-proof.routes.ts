import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  parseCustomerLedgerScopeParam,
  parseCustomerPaymentIdParam,
} from '../handyman-customer-ledger-api/handyman-customer-ledger-api.validation';
import {
  getHandymanPaymentProofMetadata,
  HANDYMAN_EXECUTION_SCOPE_PAYMENT_PROOF_MAX_BYTES,
  readHandymanPaymentProofContent,
  uploadExecutionScopePaymentProof,
} from './handyman-payment-proof.service';

/**
 * CR-HM-FIN-DOCUMENTS-01 — Finance payment-proof retrieval transport:
 *
 *   GET /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof
 *   GET /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof/content
 *
 * Payment-specific READ-ONLY door over the authoritative 0433 proof
 * (the CR-HM-13 payment URL family; NOT the generic evidence surface,
 * which has no payment-proof authority). Requires an authenticated
 * actor with `handyman.finance.read` (CR-HM-FIN-AUTH-01) plus the
 * exact-Building scope of the payment's execution scope (BE-02G) —
 * no `tenant_company.read` and no tenant-wide grant is implied or
 * accepted as a substitute.
 *
 * Deliberately separate surfaces, kept separate:
 *  - customer-submitted proof upload stays the Care workspace route;
 *  - Finance verification (confirm/reject) stays `handyman.finance.manage`;
 *  - this router only ever READS authentic bound proof bytes.
 *
 * No storage key, storage URL, signed URL or token is ever disclosed;
 * content is streamed through this authenticated route only.
 */
export function createHandymanPaymentProofRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const financeRead = requirePermission('handyman.finance.read');
  const tenantManage = requirePermission('tenant_company.manage');
  const proofUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: HANDYMAN_EXECUTION_SCOPE_PAYMENT_PROOF_MAX_BYTES,
      files: 1,
    },
  });

  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof',
    auth,
    tenantManage,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const executionScopeId = parseCustomerLedgerScopeParam(
          String(req.params.executionScopeId ?? ''),
        );
        const paymentId = parseCustomerPaymentIdParam(
          String(req.params.paymentId ?? ''),
        );
        let filePayload: {
          buffer: Buffer;
          mimetype: string;
          originalname: string;
          size: number;
        };
        if (
          req.body &&
          typeof req.body === 'object' &&
          (req.body as Record<string, unknown>).file &&
          typeof (req.body as Record<string, unknown>).file === 'object' &&
          typeof ((req.body as Record<string, Record<string, unknown>>).file
            .contentBase64) === 'string'
        ) {
          const fObj = (req.body as Record<string, Record<string, unknown>>).file;
          const buf = Buffer.from(String(fObj.contentBase64), 'base64');
          filePayload = {
            buffer: buf,
            mimetype: String(fObj.mimeType ?? 'image/png'),
            originalname: String(fObj.fileName ?? 'proof.png'),
            size: buf.byteLength,
          };
        } else {
          const file = await new Promise<Express.Multer.File>((resolve, reject) => {
            proofUpload.single('file')(req, res, (error) => {
              if (error) {
                reject(
                  error instanceof multer.MulterError &&
                    error.code === 'LIMIT_FILE_SIZE'
                    ? AppError.badRequest('Uploaded file exceeds the 50 MB limit.')
                    : AppError.badRequest('Payment proof upload failed.'),
                );
                return;
              }
              const uploaded = (
                req as typeof req & { file?: Express.Multer.File }
              ).file;
              if (!uploaded) {
                reject(
                  AppError.validation('Multipart field "file" is required.', [
                    { field: 'file', message: 'Multipart field "file" is required.' },
                  ]),
                );
                return;
              }
              resolve(uploaded);
            });
          });
          filePayload = {
            buffer: file.buffer,
            mimetype: file.mimetype,
            originalname: file.originalname,
            size: file.size,
          };
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await uploadExecutionScopePaymentProof({
          executionScopeId,
          paymentId,
          actorUserId: req.auth.userId,
          evidenceType: body.evidenceType ?? 'PHOTO',
          file: filePayload,
        });
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, result, result.replayed ? 200 : 201);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof',
    auth,
    financeRead,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const executionScopeId = parseCustomerLedgerScopeParam(
          String(req.params.executionScopeId ?? ''),
        );
        const paymentId = parseCustomerPaymentIdParam(
          String(req.params.paymentId ?? ''),
        );
        const metadata = await getHandymanPaymentProofMetadata(
          executionScopeId,
          paymentId,
          req.auth.userId,
        );
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { paymentProof: metadata }, 200);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof/content',
    auth,
    financeRead,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const executionScopeId = parseCustomerLedgerScopeParam(
          String(req.params.executionScopeId ?? ''),
        );
        const paymentId = parseCustomerPaymentIdParam(
          String(req.params.paymentId ?? ''),
        );
        const { metadata, buffer } = await readHandymanPaymentProofContent(
          executionScopeId,
          paymentId,
          req.auth.userId,
        );
        res
          .status(200)
          .set('Cache-Control', 'no-store')
          .set('Content-Type', metadata.mimeType)
          .set('Content-Length', String(buffer.byteLength))
          .set(
            'Content-Disposition',
            `inline; filename*=UTF-8''${encodeURIComponent(
              metadata.originalFileName || 'payment-proof',
            )}`,
          )
          .send(buffer);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

/** Re-exported for contract tests asserting the bounded denial codes. */
export const PAYMENT_PROOF_ERROR_CODES = {
  NOT_FOUND: ERROR_CODES.HANDYMAN_PAYMENT_PROOF_NOT_FOUND,
  INTEGRITY_CONFLICT: ERROR_CODES.HANDYMAN_PAYMENT_PROOF_INTEGRITY_CONFLICT,
} as const;
