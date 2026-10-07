import express, { Router, type Request, type Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { readWhatsAppCallbackConfig } from './whatsapp-callback.config';
import { processMetaWhatsAppCallbackPayload } from './whatsapp-callback.service';
import type { MetaWhatsAppWebhookPayload } from './whatsapp-callback.types';
import {
  verifyMetaWebhookHandshake,
  verifyMetaWebhookSignature,
} from './whatsapp-callback.verify';

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — Meta WhatsApp callback surface
 * (governance §9 route shape: one inbound route per channel/provider).
 *
 *   GET  /webhooks/notifications/whatsapp — Meta subscription handshake
 *   POST /webhooks/notifications/whatsapp — delivery feedback callbacks
 *
 * Provider-signature-authenticated ONLY (never user sessions, never RBAC).
 * Returns `null` when the webhook is disabled (the default), so nothing is
 * mounted. When enabled without the required secrets, router construction
 * fails fast (ConfigError) at boot. The POST route parses the body with
 * `express.raw` — HMAC must be computed over the exact received bytes; the
 * router is mounted BEFORE the app-wide JSON parser so the raw body is
 * intact.
 */
export function createWhatsAppCallbackRouter(): Router | null {
  const config = readWhatsAppCallbackConfig();
  if (!config.enabled || !config.appSecret || !config.verifyToken) {
    return null;
  }
  const appSecret = config.appSecret;
  const verifyToken = config.verifyToken;

  const router = Router();

  // Meta subscription handshake: echo the challenge for a verified token.
  router.get('/', (req: Request, res: Response) => {
    const challenge = verifyMetaWebhookHandshake(
      req.query as Record<string, unknown>,
      verifyToken,
    );
    if (!challenge) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  });

  // Delivery feedback callbacks: signature-verified, replay-safe.
  router.post(
    '/',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req: Request, res: Response, next) => {
      try {
        const rawBody: Buffer = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(typeof req.body === 'string' ? req.body : '');

        const signature = req.header('x-hub-signature-256');
        if (!verifyMetaWebhookSignature(rawBody, signature, appSecret)) {
          res.status(401).json({
            success: false,
            error: {
              code: 'WEBHOOK_SIGNATURE_INVALID',
              message: 'Webhook signature verification failed.',
            },
          });
          return;
        }

        let payload: MetaWhatsAppWebhookPayload;
        try {
          payload = JSON.parse(rawBody.toString('utf8')) as MetaWhatsAppWebhookPayload;
        } catch {
          res.status(400).json({
            success: false,
            error: {
              code: 'WEBHOOK_PAYLOAD_INVALID',
              message: 'Webhook payload must be valid JSON.',
            },
          });
          return;
        }

        const result = await processMetaWhatsAppCallbackPayload(payload);
        sendSuccess(res, result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
