import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { serviceCatalogService } from '../service-catalog';
import { handymanServiceVariantService } from '../handyman-catalog';
import { handymanCommonMaterialProfileService } from '../handyman-catalog';
import { handymanServiceRequestService } from '../handyman-requests';
import { handymanOperationsQueueService } from '../handyman-requests/handyman-operations-queue.service';
import {
  HANDYMAN_INTAKE_MAX_FILE_BYTES,
  handymanIntakeEvidenceService,
} from '../handyman-evidence';
import {
  parseCreateHandymanServiceRequestBody,
  parseCreateCareHandymanServiceRequestBody,
  parseHandymanClientScopeQuery,
  parseHandymanIntakeEvidenceKindField,
  parseHandymanMaterialProfileDescribeQuery,
  parseHandymanMaterialProfileIdParam,
  parseHandymanMaterialProfileListQuery,
  parseHandymanOperationsRequestListQuery,
  parseHandymanRequestIdParam,
  parseHandymanServiceRequestListQuery,
} from './handyman-api.validation';

/**
 * CR-HM-02 PART 05A — customer-facing Handyman HTTP handlers.
 *
 * Thin transport shells ONLY: every business rule stays in the PART 01–04
 * services (context derivation, scope access, master-state gates, MIME/size
 * policy, hashing). This surface never exposes:
 *   - catalogue/master mutation,
 *   - request lifecycle transitions (no triage / diagnosis / quotation /
 *     work execution / QC / BAST / cancellation — INTAKE exists only),
 *   - inventory or catalogue-media behavior,
 *   - storage paths or internal evidence keys (the public records returned
 *     here never contain file references).
 */

const p = (value: string | string[]): string =>
  (Array.isArray(value) ? value[0] : value);

/**
 * Upload transport: the existing evidence-file convention verbatim —
 * multer in-memory single file in the `file` multipart field, bounded by the
 * shared 50 MB evidence byte policy (PART 04 constant is byte-identical to
 * the catalog convention's MAX_EVIDENCE_FILE_BYTES), the same oversize
 * message, and multipart text fields read after the upload has parsed.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HANDYMAN_INTAKE_MAX_FILE_BYTES, files: 1 },
});

function runSingleFileUpload(
  req: Request,
  res: Response,
): Promise<Express.Multer.File> {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          reject(AppError.badRequest('Uploaded file exceeds the 50 MB limit.'));
          return;
        }
        reject(AppError.badRequest('File upload failed.'));
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        reject(
          AppError.validation('Request validation failed.', [
            {
              field: 'file',
              message: 'Multipart field "file" is required.',
            },
          ]),
        );
        return;
      }
      resolve(file);
    });
  });
}

/**
 * GET /handyman/catalogue/services — read-only catalogue: the ACTIVE
 * service entries available for Handyman in the caller-visible Client,
 * each with its ACTIVE Handyman variants. No-leak posture comes from the
 * shared service-catalog list (foreign Client ⇒ empty list).
 */
export async function listHandymanCatalogueServicesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseHandymanClientScopeQuery(req.query);
    const entries = await serviceCatalogService.listServiceCatalogEntries(
      { clientId, status: 'ACTIVE' },
      req.auth.userId,
    );
    const catalogue = await Promise.all(
      entries.map(async (service) => ({
        service,
        variants: await handymanServiceVariantService.listHandymanServiceVariants(
          { clientId, serviceCatalogId: service.id, status: 'ACTIVE' },
          req.auth.userId,
        ),
      })),
    );
    sendSuccess(res, catalogue);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /handyman/catalogue/material-profiles — ACTIVE common material
 * profiles for a Client (optionally refined by service / variant).
 */
export async function listHandymanMaterialProfilesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseHandymanMaterialProfileListQuery(req.query);
    const profiles = await handymanCommonMaterialProfileService
      .listHandymanCommonMaterialProfiles(
        { ...filters, status: 'ACTIVE' },
        req.auth.userId,
      );
    sendSuccess(res, profiles);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /handyman/catalogue/material-profiles/:profileId — one profile with
 * its PART 02 read-time-composed reference price (null when the governed
 * price lookup cannot resolve an applicable price — never guessed).
 */
export async function describeHandymanMaterialProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const profileId = parseHandymanMaterialProfileIdParam(p(req.params.profileId));
    const context = parseHandymanMaterialProfileDescribeQuery(req.query);
    const entry = await handymanCommonMaterialProfileService
      .describeHandymanCommonMaterialProfile(profileId, req.auth.userId, context);
    sendSuccess(res, entry);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/requests — create the Handyman request from the immutable
 * attribution provenance handle (PART 03). Caller-supplied context keys are
 * ignored by contract; the attribution snapshot is the sole authority.
 */
export async function createHandymanServiceRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateHandymanServiceRequestBody(req.body);
    const request = await handymanServiceRequestService
      .createHandymanServiceRequest(input, req.auth.userId);
    sendSuccess(res, request, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/requests/care — one-time, attested BM Customer Care intake.
 * The exchange token, not a caller's User/PIC or attribution ID, authorizes
 * this create. The service atomically binds provenance and creates INTAKE.
 */
export async function createCareHandymanServiceRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateCareHandymanServiceRequestBody(req.body);
    const request = await handymanServiceRequestService.createCareHandymanServiceRequest(input);
    sendSuccess(res, request, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /handyman/requests — CR-HM-17 GAP PART 01 bounded Customer Care
 * request list read projection (governed request/status, Backend-resolved
 * attribution/care-actor provenance, and execution-scope pointer where
 * present).
 */
export async function listHandymanServiceRequestsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseHandymanServiceRequestListQuery(req.query);
    const requests = await handymanServiceRequestService
      .listHandymanServiceRequests(filters, req.auth.userId);
    sendSuccess(res, requests);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /handyman/requests/:handymanRequestId — CR-HM-17 GAP PART 01 bounded
 * Customer Care request detail read projection (governed request/status,
 * Backend-resolved attribution/care-actor provenance, and execution-scope
 * pointer where present).
 */
export async function getHandymanServiceRequestDetailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const request = await handymanServiceRequestService
      .getHandymanServiceRequestDetail(handymanRequestId, req.auth.userId);
    sendSuccess(res, request);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /handyman/operations/requests — W02 PART 02 Operations queue list.
 * Scope is the caller's explicit Building assignments (no PIC/C6 shortcut).
 */
export async function listHandymanOperationsRequestsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseHandymanOperationsRequestListQuery(req.query);
    const page = await handymanOperationsQueueService
      .listOperationsRequests(query, req.auth.userId);
    sendSuccess(res, page);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/operations/requests/:handymanRequestId — triage detail. */
export async function getHandymanOperationsRequestDetailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const request = await handymanOperationsQueueService
      .getOperationsRequestDetail(handymanRequestId, req.auth.userId);
    sendSuccess(res, request);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/requests/:handymanRequestId/intake-evidence — bounded
 * PHOTO/VIDEO intake upload (PART 04). The Handyman request in the URL is
 * the only context authority; the request lifecycle is never mutated.
 */
export async function uploadHandymanIntakeEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const file = await runSingleFileUpload(req, res);
    const evidenceKind = parseHandymanIntakeEvidenceKindField(
      req.body?.evidenceKind,
    );
    const evidence = await handymanIntakeEvidenceService
      .recordHandymanIntakeEvidence(
        {
          handymanRequestId,
          evidenceKind,
          fileName: file.originalname,
          mimeType: file.mimetype,
          content: file.buffer,
        },
        req.auth.userId,
      );
    sendSuccess(res, evidence, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /handyman/requests/:handymanRequestId/intake-evidence — bounded list
 * of the intake evidence attached to one Handyman request (metadata only;
 * file bytes are downloadable only through the file-content convention).
 */
export async function listHandymanIntakeEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const evidence = await handymanIntakeEvidenceService
      .listHandymanIntakeEvidence(handymanRequestId, req.auth.userId);
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}
