import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { priceCatalogLookupAmbiguousError } from './price-catalog-entry.errors';
import { priceCatalogEntryService } from './price-catalog-entry.service';
import { priceCatalogLookupService } from './price-catalog-lookup.service';
import {
  parseCorrectPriceCatalogEntryBody,
  parseCreatePriceCatalogEntryBody,
  parsePriceCatalogEntryFilters,
  parsePriceCatalogEntryIdParam,
  parsePriceCatalogLookupQuery,
  parseReplacePriceCatalogEntryBody,
  parseUpdatePriceCatalogEntryBody,
} from './price-catalog-entry.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function idempotencyHeader(req: Request): string | undefined {
  const value = req.header('Idempotency-Key');
  return value?.trim() || undefined;
}

export async function createPriceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await priceCatalogEntryService.createPriceCatalogEntry(
        parseCreatePriceCatalogEntryBody(req.body, idempotencyHeader(req)),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getPriceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await priceCatalogEntryService.getPriceCatalogEntry(
        parsePriceCatalogEntryIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPriceCatalogEntriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await priceCatalogEntryService.listPriceCatalogEntries(
        parsePriceCatalogEntryFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePriceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await priceCatalogEntryService.updatePriceCatalogEntry(
        parsePriceCatalogEntryIdParam(param(req.params.id)),
        parseUpdatePriceCatalogEntryBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function activatePriceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await priceCatalogEntryService.activatePriceCatalogEntry(
        parsePriceCatalogEntryIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deactivatePriceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await priceCatalogEntryService.deactivatePriceCatalogEntry(
        parsePriceCatalogEntryIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/**
 * PART 02 — resolver probe. Typed outcomes are returned as data; only the
 * defensive AMBIGUOUS trip is surfaced as an error (fail closed, §8/§17).
 */
export async function lookupPriceCatalogHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await priceCatalogLookupService.lookupPriceCatalogEntry(
      parsePriceCatalogLookupQuery(req.query),
      actor(req),
    );
    if (result.resolution === 'AMBIGUOUS') {
      throw priceCatalogLookupAmbiguousError();
    }
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function replacePriceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await priceCatalogEntryService.replacePriceCatalogEntry(
        parsePriceCatalogEntryIdParam(param(req.params.id)),
        parseReplacePriceCatalogEntryBody(req.body, idempotencyHeader(req)),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

/**
 * PART 05 — governed override/corrective command. The route fence has
 * already demanded `price_catalog.override`; the parser demands the
 * mandatory reason. Responds 201 with the new corrective authority state.
 */
export async function correctPriceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await priceCatalogEntryService.correctPriceCatalogEntry(
        parsePriceCatalogEntryIdParam(param(req.params.id)),
        parseCorrectPriceCatalogEntryBody(req.body, idempotencyHeader(req)),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}
