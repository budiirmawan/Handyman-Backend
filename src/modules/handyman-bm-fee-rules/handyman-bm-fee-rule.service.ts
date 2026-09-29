import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  handymanCommercialAgreementNotFoundError,
  handymanCommercialAgreementRepository as agreementRepo,
  handymanCommercialAgreementVersionNotFoundError,
  parseHandymanAgreementTimestamp,
  resolveHandymanCommercialAgreementAt,
} from '../handyman-commercial-agreements';
import {
  handymanBmFeeRuleAlreadyDefinedError,
  handymanBmFeeRuleKeyConflictError,
  handymanBmFeeRuleNotEffectiveError,
  handymanBmFeeRuleVersionNotDraftError,
  handymanBmFeeRuleValidationError,
} from './handyman-bm-fee-rule.errors';
import { handymanBmFeeRuleRepository as repo }
  from './handyman-bm-fee-rule.repository';
import type {
  HandymanBmFeeRuleRecord,
} from './handyman-bm-fee-rule.types';
import {
  isHandymanBmFeeRuleBasis,
  isHandymanBmFeeRuleMode,
} from './handyman-bm-fee-rule.types';

/**
 * CR-HM-12 PART 04 — BM fee rule authoring + fail-closed
 * resolution ONLY (FROZEN `CR-HM-12_START_GOVERNANCE.md` §7/§10
 * PART 04).
 *
 * The rule binds to an EXACT agreement version (B6: a fee rule not
 * bound to an exact version is a STOP); it is authored only while
 * that version is DRAFT and frozen forever after. This module
 * deliberately contains NO evaluation, derivation, amount, or
 * percentage surface: fee VALUE derivation per transaction is
 * CR-HM-14's entitlement computation, charge handling is CR-HM-13's,
 * and SaaS subscription/billing state is never readable from here
 * (§7/B3). Publishing the rule contract for CR-HM-14 consumption
 * is what "BM fee rule contracts published" means at this CR's
 * exit gate.
 */

export type HandymanBmFeeRulePrepareInput = {
  agreementVersionId: string;
  basis: string;
  mode: string;
  idempotencyKey: string;
};

export type HandymanBmFeeRulePrepareResult = {
  rule: HandymanBmFeeRuleRecord;
  replayed: boolean;
};

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanBmFeeRuleValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanBmFeeRuleValidationError('idempotencyKey');
  }
  return raw;
}

export async function prepareHandymanBmFeeRule(
  actorUserId: string,
  input: HandymanBmFeeRulePrepareInput,
): Promise<HandymanBmFeeRulePrepareResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const agreementVersionId = ensureUuid(
    input.agreementVersionId,
    'agreementVersionId',
  );
  const idempotencyKey = ensureKey(input.idempotencyKey);
  const basisRaw = typeof input.basis === 'string'
    ? input.basis.trim()
    : '';
  if (!isHandymanBmFeeRuleBasis(basisRaw)) {
    throw handymanBmFeeRuleValidationError('basis');
  }
  const modeRaw = typeof input.mode === 'string'
    ? input.mode.trim()
    : '';
  if (!isHandymanBmFeeRuleMode(modeRaw)) {
    throw handymanBmFeeRuleValidationError('mode');
  }

  return withTransaction(async (client: PoolClient) => {
    const version = await agreementRepo.findVersionById(
      client,
      agreementVersionId,
    );
    if (!version) {
      throw handymanCommercialAgreementVersionNotFoundError();
    }
    const locked = await agreementRepo.findAgreementByClientId(
      client,
      version.clientId,
      true,
    );
    if (!locked || locked.id !== version.agreementId) {
      throw handymanCommercialAgreementNotFoundError();
    }

    const replay = await repo.findRuleByIdempotencyKey(
      client,
      idempotencyKey,
    );
    if (replay) {
      if (replay.agreementVersionId !== agreementVersionId) {
        throw handymanBmFeeRuleKeyConflictError();
      }
      return { rule: replay, replayed: true };
    }

    if (version.status !== 'DRAFT') {
      throw handymanBmFeeRuleVersionNotDraftError(agreementVersionId);
    }

    const existing = await repo.findRuleByVersion(client, version.id);
    if (existing) {
      throw handymanBmFeeRuleAlreadyDefinedError(version.id);
    }

    const rule = await repo.insertRule(client, {
      agreementVersionId: version.id,
      basis: basisRaw,
      mode: modeRaw,
      idempotencyKey,
      createdByUserId: actor,
    });
    return { rule, replayed: false };
  });
}

/** The frozen rule of one exact version (null when it has none). */
export async function getHandymanBmFeeRuleForVersion(
  agreementVersionId: string,
): Promise<HandymanBmFeeRuleRecord | null> {
  const versionId = ensureUuid(
    agreementVersionId,
    'agreementVersionId',
  );
  const version = await agreementRepo.findVersionById(
    getPool(),
    versionId,
  );
  if (!version) {
    throw handymanCommercialAgreementVersionNotFoundError();
  }
  return repo.findRuleByVersion(getPool(), versionId);
}

/**
 * Fail-closed as-of resolution for CR-HM-14 consumption (§7 "the
 * published rule contract"): client + asOf resolve the EXACT
 * effective agreement version through the PART 01 anchor, and that
 * version's frozen rule must exist on it. Missing rule = bounded
 * conflict — never a silent default and never another version's
 * rule; the fee VALUE itself is never computed here.
 */
export async function resolveHandymanBmFeeRuleAt(
  clientId: string,
  asOf: string,
): Promise<HandymanBmFeeRuleRecord> {
  const client = ensureUuid(clientId, 'clientId');
  const instant = parseHandymanAgreementTimestamp(asOf, 'asOf');
  const version = await resolveHandymanCommercialAgreementAt(
    client,
    instant.toISOString(),
  );
  const rule = await repo.findRuleByVersion(getPool(), version.id);
  if (!rule) {
    throw handymanBmFeeRuleNotEffectiveError(instant.toISOString());
  }
  return rule;
}
