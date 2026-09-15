import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorComplianceDocumentService } from './vendor-compliance-document.service';
import {
  parseCreateVendorComplianceDocumentBody,
  parseUpdateVendorComplianceDocumentBody,
  parseVendorComplianceDocumentIdParam,
  parseVendorComplianceVendorIdParam,
} from './vendor-compliance-document.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createVendorComplianceDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorComplianceVendorIdParam(
      paramString(req.params.vendorId),
    );
    const input = parseCreateVendorComplianceDocumentBody(req.body);
    const document =
      await vendorComplianceDocumentService.createVendorComplianceDocument({
        ...input,
        vendorId,
      });
    sendSuccess(res, document, 201);
  } catch (error) {
    next(error);
  }
}

export async function listVendorComplianceDocumentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorComplianceVendorIdParam(
      paramString(req.params.vendorId),
    );
    const documents =
      await vendorComplianceDocumentService.listVendorComplianceDocumentsByVendor(
        vendorId,
      );
    sendSuccess(res, documents);
  } catch (error) {
    next(error);
  }
}

export async function getVendorComplianceDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorComplianceDocumentIdParam(paramString(req.params.id));
    const document =
      await vendorComplianceDocumentService.getVendorComplianceDocumentById(id);
    sendSuccess(res, document);
  } catch (error) {
    next(error);
  }
}

export async function updateVendorComplianceDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorComplianceDocumentIdParam(paramString(req.params.id));
    const input = parseUpdateVendorComplianceDocumentBody(req.body);
    const document =
      await vendorComplianceDocumentService.updateVendorComplianceDocument(
        id,
        input,
      );
    sendSuccess(res, document);
  } catch (error) {
    next(error);
  }
}
