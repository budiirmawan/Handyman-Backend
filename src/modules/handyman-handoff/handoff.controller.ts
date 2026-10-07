import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { bindHandoffExchangeToChannelAttribution } from './handoff-binding.service';
import { acceptHandoffAssertion } from './handoff-runtime.service';

/**
 * CR-HM-01 PART 05 — HTTP controllers for the secure BM handoff flow
 * (frozen D3: versioned /api/v1 only, never /webhooks).
 *
 * Controllers hold NO business rules: PART 03 authenticates the
 * integration-signed assertion and PART 04 atomically consumes the one-time
 * exchange. The raw signature header and the raw exchange token are passed
 * straight to the service layer — never logged, never echoed. A Bearer user
 * session is not a substitute for the assertion signature; no standard user
 * session is created here, and no service request is created here.
 */

/** Signed-payload header convention (same family as whatsapp-callback). */
const SIGNATURE_HEADER = 'x-hub-signature-256';

export async function acceptHandoffAssertionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const accepted = await acceptHandoffAssertion(
      req.body,
      req.header(SIGNATURE_HEADER),
    );
    sendSuccess(res, {
      exchangeToken: accepted.exchangeToken,
      expiresAt: accepted.expiresAt.toISOString(),
      context: accepted.context,
    }, 201);
  } catch (error) {
    next(error);
  }
}

export async function bindHandoffAttributionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Token extraction only — validity is decided exclusively by PART 04.
    const body = req.body as { exchangeToken?: unknown } | null;
    const exchangeToken =
      body !== null && typeof body === 'object' &&
      typeof body.exchangeToken === 'string'
        ? body.exchangeToken
        : '';
    const attribution =
      await bindHandoffExchangeToChannelAttribution(exchangeToken);
    sendSuccess(res, attribution, 201);
  } catch (error) {
    next(error);
  }
}
