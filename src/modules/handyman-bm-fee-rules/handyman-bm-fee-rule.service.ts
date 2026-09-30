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
  handymanBmFeeBeneficiaryAlreadyDefinedError,
  handymanBmFeeBeneficiaryClientMismatchError,
  handymanBmFeeBeneficiaryKeyConflictError,
  handymanBmFeeBeneficiaryValidationError,
  handymanBmFeeBeneficiaryVersionNotDraftError,
  handymanBmFeeRuleAlreadyDefinedError,
  handymanBmFeeRuleKeyConflictError,
  handymanBmFeeRuleNotEffectiveError,
  handymanBmFeeRuleVersionNotDraftError,
  handymanBmFeeRuleValidationError,
  handymanBmFeeTermAlreadyDefinedError,
  handymanBmFeeTermKeyConflictError,
  handymanBmFeeTermValidationError,
  handymanBmFeeTermVersionNotDraftError,
} from './handyman-bm-fee-rule.errors';
import {
  handymanBmFeePrerequisiteRepository as prerequisiteRepo,
  handymanBmFeeRuleRepository as repo,
} from './handyman-bm-fee-rule.repository';
import type {
  HandymanBmFeeBeneficiaryRecord,
  HandymanBmFeeRuleRecord,
  HandymanBmFeeTermRecord,
} from './handyman-bm-fee-rule.types';
import {
  HANDYMAN_BM_FEE_RATE_SCALE,
  isHandymanBmFeeBeneficiaryKind,
  isHandymanBmFeeRuleBasis,
  isHandymanBmFeeRuleMode,
  isHandymanBmFeeTermKind,
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

/* ------------------------------------------------------------------
 * CR-HM-12 PART 06B — BM fee TERM + BENEFICIARY authoring and exact
 * reads (FROZEN `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` §4.3,
 * authorized by `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md` §2/§3).
 *
 * Both facts are authored ONLY while the bound agreement version is
 * DRAFT and are frozen forever after (revision = a NEW version); the
 * 0415 triggers enforce the same law at the database, so a service
 * bypass cannot author outside the window. Exactly one term and one
 * beneficiary exist per version.
 *
 * NOTHING here multiplies, applies, or stores a fee VALUE: the term
 * publishes a rate as canonical decimal data and the beneficiary
 * publishes a payee identity. Arithmetic is CR-HM-14's entitlement
 * authority; charge/ledger authority is CR-HM-13's. No SaaS or FM
 * state is reachable from this module.
 * ------------------------------------------------------------------ */

export type HandymanBmFeeTermPrepareInput = {
  agreementVersionId: string;
  termKind: string;
  ratePercent: string;
  idempotencyKey: string;
};

export type HandymanBmFeeTermPrepareResult = {
  term: HandymanBmFeeTermRecord;
  replayed: boolean;
};

export type HandymanBmFeeBeneficiaryPrepareInput = {
  agreementVersionId: string;
  beneficiaryKind: string;
  beneficiaryReferenceId: string;
  idempotencyKey: string;
};

export type HandymanBmFeeBeneficiaryPrepareResult = {
  beneficiary: HandymanBmFeeBeneficiaryRecord;
  replayed: boolean;
};

/* Bounded input guards specific to the two prerequisite facts, so a
 * malformed term/beneficiary payload answers with ITS OWN code (never
 * a borrowed rule error). */

function ensureTermUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanBmFeeTermValidationError(field);
  }
  return raw;
}

function ensureTermKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanBmFeeTermValidationError('idempotencyKey');
  }
  return raw;
}

function ensureBeneficiaryUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanBmFeeBeneficiaryValidationError(field);
  }
  return raw;
}

function ensureBeneficiaryKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanBmFeeBeneficiaryValidationError('idempotencyKey');
  }
  return raw;
}

/** Canonical decimal: at most 3 integer digits + exactly 0..4 decimals. */
const RATE_PATTERN = /^(0|[1-9]\d{0,2})(\.\d{1,4})?$/;
const RATE_SCALE_UNITS = 10 ** HANDYMAN_BM_FEE_RATE_SCALE;
/** Upper bound 100 at the frozen scale (100.0000). */
const RATE_MAX_SCALED = 100 * RATE_SCALE_UNITS;

/**
 * Validate + canonicalize a rate into an exact integer count of
 * ten-thousandths (integer arithmetic only — no float ever touches a
 * governed rate). Rejects zero, negatives, values above 100,
 * exponents, and anything beyond the frozen 4-decimal scale.
 */
function parseRatePercent(raw: unknown): {
  canonical: string;
  scaled: number;
} {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const match = RATE_PATTERN.exec(text);
  if (!match) {
    throw handymanBmFeeTermValidationError('ratePercent');
  }
  const whole = match[1];
  const fraction = (match[2] ?? '').slice(1)
    .padEnd(HANDYMAN_BM_FEE_RATE_SCALE, '0');
  const scaled = Number(whole) * RATE_SCALE_UNITS + Number(fraction);
  if (
    !Number.isSafeInteger(scaled)
    || scaled <= 0
    || scaled > RATE_MAX_SCALED
  ) {
    throw handymanBmFeeTermValidationError('ratePercent');
  }
  return { canonical: `${whole}.${fraction}`, scaled };
}

export async function prepareHandymanBmFeeTerm(
  actorUserId: string,
  input: HandymanBmFeeTermPrepareInput,
): Promise<HandymanBmFeeTermPrepareResult> {
  const actor = ensureTermUuid(actorUserId, 'actorUserId');
  const agreementVersionId = ensureTermUuid(
    input.agreementVersionId,
    'agreementVersionId',
  );
  const idempotencyKey = ensureTermKey(input.idempotencyKey);
  const termKindRaw = typeof input.termKind === 'string'
    ? input.termKind.trim()
    : '';
  if (!isHandymanBmFeeTermKind(termKindRaw)) {
    throw handymanBmFeeTermValidationError('termKind');
  }
  const rate = parseRatePercent(input.ratePercent);

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

    const replay = await prerequisiteRepo.findTermByIdempotencyKey(
      client,
      idempotencyKey,
    );
    if (replay) {
      const sameIntent = replay.agreementVersionId === agreementVersionId
        && replay.termKind === termKindRaw
        && replay.ratePercent === rate.canonical;
      if (!sameIntent) {
        throw handymanBmFeeTermKeyConflictError();
      }
      return { term: replay, replayed: true };
    }

    if (version.status !== 'DRAFT') {
      throw handymanBmFeeTermVersionNotDraftError(agreementVersionId);
    }

    const existing = await prerequisiteRepo.findTermByVersion(
      client,
      version.id,
    );
    if (existing) {
      throw handymanBmFeeTermAlreadyDefinedError(version.id);
    }

    const term = await prerequisiteRepo.insertTerm(client, {
      agreementVersionId: version.id,
      termKind: termKindRaw,
      ratePercent: rate.canonical,
      idempotencyKey,
      createdByUserId: actor,
    });
    return { term, replayed: false };
  });
}

export async function prepareHandymanBmFeeBeneficiary(
  actorUserId: string,
  input: HandymanBmFeeBeneficiaryPrepareInput,
): Promise<HandymanBmFeeBeneficiaryPrepareResult> {
  const actor = ensureBeneficiaryUuid(actorUserId, 'actorUserId');
  const agreementVersionId = ensureBeneficiaryUuid(
    input.agreementVersionId,
    'agreementVersionId',
  );
  const idempotencyKey = ensureBeneficiaryKey(input.idempotencyKey);
  const kindRaw = typeof input.beneficiaryKind === 'string'
    ? input.beneficiaryKind.trim()
    : '';
  if (!isHandymanBmFeeBeneficiaryKind(kindRaw)) {
    throw handymanBmFeeBeneficiaryValidationError('beneficiaryKind');
  }
  const referenceId = ensureBeneficiaryUuid(
    input.beneficiaryReferenceId,
    'beneficiaryReferenceId',
  );

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

    const replay = await prerequisiteRepo.findBeneficiaryByIdempotencyKey(
      client,
      idempotencyKey,
    );
    if (replay) {
      const sameIntent = replay.agreementVersionId === agreementVersionId
        && replay.beneficiaryKind === kindRaw
        && replay.beneficiaryReferenceId === referenceId;
      if (!sameIntent) {
        throw handymanBmFeeBeneficiaryKeyConflictError();
      }
      return { beneficiary: replay, replayed: true };
    }

    // The beneficiary is the bound version's OWN governed client:
    // server-derived, never inferred from caller input, channel
    // attribution, vendor/PIC, or any client lookup.
    if (referenceId !== version.clientId) {
      throw handymanBmFeeBeneficiaryClientMismatchError();
    }

    if (version.status !== 'DRAFT') {
      throw handymanBmFeeBeneficiaryVersionNotDraftError(
        agreementVersionId,
      );
    }

    const existing = await prerequisiteRepo.findBeneficiaryByVersion(
      client,
      version.id,
    );
    if (existing) {
      throw handymanBmFeeBeneficiaryAlreadyDefinedError(version.id);
    }

    const beneficiary = await prerequisiteRepo.insertBeneficiary(client, {
      agreementVersionId: version.id,
      beneficiaryKind: kindRaw,
      beneficiaryReferenceId: referenceId,
      idempotencyKey,
      createdByUserId: actor,
    });
    return { beneficiary, replayed: false };
  });
}

/** The frozen term of one exact version (null when unconfigured). */
export async function getHandymanBmFeeTermForVersion(
  agreementVersionId: string,
): Promise<HandymanBmFeeTermRecord | null> {
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
  return prerequisiteRepo.findTermByVersion(getPool(), versionId);
}

/** The frozen beneficiary of one exact version (null when unconfigured). */
export async function getHandymanBmFeeBeneficiaryForVersion(
  agreementVersionId: string,
): Promise<HandymanBmFeeBeneficiaryRecord | null> {
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
  return prerequisiteRepo.findBeneficiaryByVersion(getPool(), versionId);
}
