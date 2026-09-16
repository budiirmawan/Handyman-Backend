import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanQuotationApprovalLinkAlreadyActiveError,
  handymanQuotationApprovalLinkNotFoundError,
  handymanQuotationApprovalLinkStateInvalidError,
  handymanQuotationApprovalNotFoundError,
  handymanQuotationApprovalStateInvalidError,
} from './handyman-quotation-approval.errors';
import { handymanQuotationApprovalRepository } from './handyman-quotation-approval.repository';
import { handymanQuotationApprovalLinkRepository } from './handyman-quotation-approval-link.repository';
import type {
  HandymanQuotationApprovalLinkRecord,
  IssueHandymanQuotationApprovalLinkInput,
  IssueHandymanQuotationApprovalLinkResult,
  PublicHandymanQuotationApprovalLink,
} from './handyman-quotation-approval.types';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { loadQuotationOrThrow } from './handyman-quotation.service';

/**
 * CR-HM-BE-03 RUN 3 — Secure-link READINESS ONLY.
 *
 * Persistence + governed staff surfaces (issue / revoke / read) for a future
 * SECURE_LINK approval method. Security properties enforced here and by
 * migration 0352:
 * - token = 32 crypto-random bytes (256 bits), base64url — it contains NO
 *   quotation/request/resource identifiers;
 * - the RAW token is returned EXACTLY ONCE at issuance and is never stored;
 *   only its SHA-256 hex hash is persisted (hash-only storage);
 * - expires_at is required (future at issuance); max_uses is fixed at 1;
 * - ACTIVE/USED/REVOKED/EXPIRED lifecycle with guarded atomic transitions
 *   (revoke/consume/expiry races have one winner);
 * - one ACTIVE link per approval (partial unique index);
 * - issue/revoke/read require authenticated governed staff building access.
 *
 * Deliberately NOT provided in Run 3: any public resolve/decide endpoint,
 * anonymous approval surface, token-only disclosure surface, or any decision
 * runtime that consumes the token. The internal consumption primitive below
 * is readiness-only and is NOT re-exported through the module index; the
 * SECURE_LINK decision method is structurally unreachable (migration-0352
 * decided-state CHECK admits IN_APP/ASSISTED only). Public link endpoints
 * are deferred to the explicit platform-security follow-up CR.
 */

const UNIQUE_VIOLATION = '23505';
const ONE_ACTIVE_LINK_CONSTRAINT =
  'handyman_quotation_approval_links_one_active_per_approval';

/** 256-bit crypto-random token, URL-safe, no embedded identifiers. */
function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function toPublicHandymanQuotationApprovalLink(
  record: HandymanQuotationApprovalLinkRecord,
): PublicHandymanQuotationApprovalLink {
  // token_hash is deliberately excluded — read surfaces never disclose it.
  return {
    id: record.id,
    approvalId: record.approvalId,
    quotationId: record.quotationId,
    status: record.status,
    recipientName: record.recipientName,
    recipientPhone: record.recipientPhone,
    recipientEmail: record.recipientEmail,
    maxUses: record.maxUses,
    usesCount: record.usesCount,
    expiresAt: record.expiresAt.toISOString(),
    issuedByUserId: record.issuedByUserId,
    issuedAt: record.issuedAt.toISOString(),
    usedAt: record.usedAt ? record.usedAt.toISOString() : null,
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
    revokedByUserId: record.revokedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function parseRecipientName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200) {
    throw AppError.validation('Request validation failed.', [
      { field: 'recipientName', message: 'recipientName is required (1-200 characters).' },
    ]);
  }
  return value.trim();
}

function parseOptionalContact(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a non-empty string of at most 200 characters.` },
    ]);
  }
  return value.trim();
}

function parseExpiresAt(value: unknown): Date {
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'expiresAt', message: 'expiresAt is required (ISO-8601 timestamp).' },
    ]);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.validation('Request validation failed.', [
      { field: 'expiresAt', message: 'expiresAt must be a valid ISO-8601 timestamp.' },
    ]);
  }
  if (parsed.getTime() <= Date.now()) {
    throw AppError.validation('Request validation failed.', [
      { field: 'expiresAt', message: 'expiresAt must be in the future at issuance.' },
    ]);
  }
  return parsed;
}

export async function issueHandymanQuotationApprovalLink(
  input: IssueHandymanQuotationApprovalLinkInput,
  actorUserId: string,
): Promise<IssueHandymanQuotationApprovalLinkResult> {
  const recipientName = parseRecipientName(input.recipientName);
  const recipientPhone = parseOptionalContact(input.recipientPhone, 'recipientPhone');
  const recipientEmail = parseOptionalContact(input.recipientEmail, 'recipientEmail');
  const expiresAt = parseExpiresAt(input.expiresAt);
  if (!isValidUuid(input.approvalId)) throw handymanQuotationApprovalNotFoundError();

  return withTransaction(async (tx) => {
    const approval = await handymanQuotationApprovalRepository.lockById(
      input.approvalId,
      tx,
    );
    if (!approval) throw handymanQuotationApprovalNotFoundError();
    // Governed staff surface (permission code handyman_quotation_approval_link.manage
    // is seeded for the Run-4 HTTP/RBAC wiring).
    const quotation = await loadQuotationOrThrow(approval.quotationId, actorUserId, tx, {
      forUpdate: true,
    });
    if (quotation.status !== 'SENT') {
      throw handymanQuotationApprovalStateInvalidError(
        'A secure link can only be issued while the quotation is SENT.',
      );
    }
    if (approval.status !== 'PENDING') {
      throw handymanQuotationApprovalStateInvalidError(
        'A secure link can only be issued for a PENDING approval.',
      );
    }
    if (quotation.sentRevisionId !== approval.quotationRevisionId) {
      throw handymanQuotationApprovalStateInvalidError(
        'The approval is not bound to the sent revision of this quotation.',
      );
    }

    const rawToken = generateRawToken();
    let link: HandymanQuotationApprovalLinkRecord;
    try {
      link = await handymanQuotationApprovalLinkRepository.create(
        {
          approvalId: approval.id,
          quotationId: quotation.id,
          clientId: quotation.clientId,
          buildingId: quotation.buildingId,
          tokenHash: hashToken(rawToken),
          recipientName,
          recipientPhone,
          recipientEmail,
          expiresAt,
          issuedByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error as { code?: string }).code === UNIQUE_VIOLATION &&
        (error as { constraint?: string }).constraint === ONE_ACTIVE_LINK_CONSTRAINT
      ) {
        throw handymanQuotationApprovalLinkAlreadyActiveError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_APPROVAL_LINK_ISSUED',
        entityType: 'HANDYMAN_QUOTATION_APPROVAL_LINK',
        entityId: link.id,
        actorUserId,
        summary: `Secure approval link issued for quotation ${quotation.quotationNumber}.`,
        // No token, no hash, no recipient contact details — link identity only.
        metadata: {
          linkId: link.id,
          approvalId: approval.id,
          quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber,
          expiresAt: link.expiresAt.toISOString(),
          maxUses: link.maxUses,
        },
      },
      tx,
    );

    // The raw token exists ONLY in this return value — once.
    return { rawToken, link: toPublicHandymanQuotationApprovalLink(link) };
  });
}

export async function revokeHandymanQuotationApprovalLink(
  linkId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationApprovalLink> {
  if (!isValidUuid(linkId)) throw handymanQuotationApprovalLinkNotFoundError();
  return withTransaction(async (tx) => {
    const link = await handymanQuotationApprovalLinkRepository.findById(linkId, tx);
    if (!link) throw handymanQuotationApprovalLinkNotFoundError();
    const quotation = await loadQuotationOrThrow(link.quotationId, actorUserId, tx);
    const revoked = await handymanQuotationApprovalLinkRepository.revokeFromActive(
      link.id,
      actorUserId,
      tx,
    );
    if (!revoked) {
      throw handymanQuotationApprovalLinkStateInvalidError(
        link.status === 'REVOKED'
          ? 'The secure link is already REVOKED.'
          : `Only an ACTIVE secure link can be revoked (current status ${link.status}).`,
      );
    }
    await recordOperationalEvent(
      {
        clientId: quotation.clientId,
        buildingId: quotation.buildingId,
        eventType: 'HANDYMAN_QUOTATION_APPROVAL_LINK_REVOKED',
        entityType: 'HANDYMAN_QUOTATION_APPROVAL_LINK',
        entityId: revoked.id,
        actorUserId,
        summary: `Secure approval link revoked for quotation ${quotation.quotationNumber}.`,
        metadata: {
          linkId: revoked.id,
          approvalId: revoked.approvalId,
          quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber,
        },
      },
      tx,
    );
    return toPublicHandymanQuotationApprovalLink(revoked);
  });
}

export async function getHandymanQuotationApprovalLink(
  linkId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationApprovalLink> {
  if (!isValidUuid(linkId)) throw handymanQuotationApprovalLinkNotFoundError();
  return withTransaction(async (tx) => {
    const link = await handymanQuotationApprovalLinkRepository.findById(linkId, tx);
    if (!link) throw handymanQuotationApprovalLinkNotFoundError();
    await loadQuotationOrThrow(link.quotationId, actorUserId, tx);
    return toPublicHandymanQuotationApprovalLink(link);
  });
}

export async function listHandymanQuotationApprovalLinks(
  quotationId: string,
  actorUserId: string,
): Promise<PublicHandymanQuotationApprovalLink[]> {
  return withTransaction(async (tx) => {
    const quotation = await loadQuotationOrThrow(quotationId, actorUserId, tx);
    const records = await handymanQuotationApprovalLinkRepository.listByQuotation(
      quotation.id,
      tx,
    );
    return records.map(toPublicHandymanQuotationApprovalLink);
  });
}

/**
 * INTERNAL READINESS PRIMITIVE — atomic single-use token consumption.
 *
 * Deliberately NOT re-exported through the module index and NOT wired to any
 * decision, service surface, or route in Run 3: consuming a link is not an
 * approval decision, and the SECURE_LINK decision method must remain
 * unreachable until the platform-security follow-up CR governs public
 * resolve/decide. Kept here (and exercised only by focused tests) so the
 * future surface inherits a race-safe primitive: one guarded statement
 * resolves consume vs revoke vs expiry with a single winner.
 */
export async function consumeApprovalLinkTokenInternal(
  rawToken: string,
  executor?: Pick<PoolClient, 'query'>,
): Promise<{ linkId: string; approvalId: string; quotationId: string } | null> {
  if (typeof rawToken !== 'string' || rawToken.trim().length === 0) return null;
  const consumed = await handymanQuotationApprovalLinkRepository.consumeByTokenHash(
    hashToken(rawToken),
    executor,
  );
  if (!consumed) return null;
  return {
    linkId: consumed.id,
    approvalId: consumed.approvalId,
    quotationId: consumed.quotationId,
  };
}

export const handymanQuotationApprovalLinkService = {
  issueHandymanQuotationApprovalLink,
  revokeHandymanQuotationApprovalLink,
  getHandymanQuotationApprovalLink,
  listHandymanQuotationApprovalLinks,
};
