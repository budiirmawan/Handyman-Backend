import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { vendorInvoiceService } from './vendor-invoice.service';
import {
  parseCreateVendorInvoiceBody,
  parseRecordVendorPaymentBody,
  parseUpdateVendorInvoiceBody,
  parseVendorInvoiceFilters,
  parseVendorInvoiceIdParam,
  parseVendorInvoiceVendorIdParam,
  parseVerifyVendorInvoiceBody,
} from './vendor-invoice.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createVendorInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorInvoiceVendorIdParam(
      param(req.params.vendorId),
    );
    sendSuccess(
      res,
      await vendorInvoiceService.createVendorInvoice(
        vendorId,
        parseCreateVendorInvoiceBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getVendorInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.getVendorInvoice(
        parseVendorInvoiceIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listVendorInvoicesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.listVendorInvoices(
        parseVendorInvoiceFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getVendorInvoiceAvailableActionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.resolveVendorInvoiceAvailableActions(
        parseVendorInvoiceIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateVendorInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.updateVendorInvoice(
        parseVendorInvoiceIdParam(param(req.params.id)),
        parseUpdateVendorInvoiceBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function finalizeVendorInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.finalizeVendorInvoice(
        parseVendorInvoiceIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelVendorInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.cancelVendorInvoice(
        parseVendorInvoiceIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ─── PART 02: Verification / Matching ───────────────────────────

export async function verifyVendorInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await vendorInvoiceService.verifyVendorInvoice(
      parseVendorInvoiceIdParam(param(req.params.id)),
      parseVerifyVendorInvoiceBody(req.body),
      actor(req),
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function getVendorInvoiceMatchingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.getVendorInvoiceMatching(
        parseVendorInvoiceIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ─── PART 03: Payment Status ────────────────────────────────────

export async function recordVendorPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.recordVendorPayment(
        parseVendorInvoiceIdParam(param(req.params.id)),
        parseRecordVendorPaymentBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ─── PART 04: Settlement Readiness ──────────────────────────────

export async function getSettlementReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.getSettlementReadiness(
        parseVendorInvoiceIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ─── PART 05: Vendor Consistency + BAST Hard Gate + Trace ───────

export async function getVendorInvoiceConsistencyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.getVendorInvoiceConsistency(
        parseVendorInvoiceIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getVendorInvoiceTraceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorInvoiceService.getVendorInvoiceTrace(
        parseVendorInvoiceIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
