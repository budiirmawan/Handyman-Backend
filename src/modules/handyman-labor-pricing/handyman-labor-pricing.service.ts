import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  handymanCommercialAgreementNotFoundError,
  handymanCommercialAgreementRepository as agreementRepo,
  handymanCommercialAgreementVersionNotFoundError,
  resolveHandymanCommercialAgreementAt,
} from '../handyman-commercial-agreements';
import {
  handymanLaborPricingBasisNotEffectiveError,
  handymanLaborPricingKeyConflictError,
  handymanLaborPricingModeConflictError,
  handymanLaborPricingValidationError,
  handymanLaborPricingVersionNotDraftError,
} from './handyman-labor-pricing.errors';
import {
  assertHandymanLaborPricingShape,
  parseHandymanLaborUnitAmount,
} from './handyman-labor-pricing.evaluate';
import { handymanLaborPricingRepository as repo }
  from './handyman-labor-pricing.repository';
import type { HandymanLaborPricingBasisRecord }
  from './handyman-labor-pricing.types';
import {
  isHandymanBillableTimeBasis,
  isHandymanCrewPricingMode,
  isHandymanLaborPricingCurrency,
  isHandymanLaborPricingMode,
} from './handyman-labor-pricing.types';

/**
 * CR-HM-12 PART 02 — labor & crew pricing basis authoring +
 * fail-closed resolution ONLY (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §4/§5/§10 PART 02).
 *
 * Definitions are immutable append-only facts bound to an EXACT
 * agreement version id (§5 binding law; B7: no "latest" reads).
 * They may be authored ONLY while that version is DRAFT — the
 * frozen set of an effective version never grows or edits; revision
 * means a new agreement version. No session/crew reads, no
 * material basis (PART 03), no BM fee rules (PART 04), no ledger
 * (CR-HM-13), no HTTP.
 */

export type HandymanLaborPricingBasisPrepareInput = {
  agreementVersionId: string;
  mode: string;
  crewMode: string;
  billableTimeBasis: string | null;
  unitAmount: string;
  currency: string;
  idempotencyKey: string;
};

export type HandymanLaborPricingBasisPrepareResult = {
  basis: HandymanLaborPricingBasisRecord;
  replayed: boolean;
};

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanLaborPricingValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanLaborPricingValidationError('idempotencyKey');
  }
  return raw;
}

function normalize(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) {
    throw handymanLaborPricingValidationError(field);
  }
  return raw;
}

export async function prepareHandymanLaborPricingBasis(
  actorUserId: string,
  input: HandymanLaborPricingBasisPrepareInput,
): Promise<HandymanLaborPricingBasisPrepareResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const agreementVersionId = ensureUuid(
    input.agreementVersionId,
    'agreementVersionId',
  );
  const idempotencyKey = ensureKey(input.idempotencyKey);

  const modeStr = normalize(input.mode, 'mode');
  if (!isHandymanLaborPricingMode(modeStr)) {
    throw handymanLaborPricingValidationError('mode');
  }
  const crewModeStr = normalize(input.crewMode, 'crewMode');
  if (!isHandymanCrewPricingMode(crewModeStr)) {
    throw handymanLaborPricingValidationError('crewMode');
  }
  const basisStr = input.billableTimeBasis === null
    ? null
    : normalize(input.billableTimeBasis, 'billableTimeBasis');
  if (basisStr !== null && !isHandymanBillableTimeBasis(basisStr)) {
    throw handymanLaborPricingValidationError('billableTimeBasis');
  }
  // Cross-field law (mirrors the migration CHECKs) after per-field
  // vocabulary narrowing.
  assertHandymanLaborPricingShape({
    mode: modeStr,
    crewMode: crewModeStr,
    billableTimeBasis: basisStr,
  });
  const currencyStr = normalize(input.currency, 'currency');
  if (!isHandymanLaborPricingCurrency(currencyStr)) {
    throw handymanLaborPricingValidationError('currency');
  }
  const unitAmount = parseHandymanLaborUnitAmount(input.unitAmount);

  return withTransaction(async (client: PoolClient) => {
    const version = await agreementRepo.findVersionById(
      client,
      agreementVersionId,
    );
    if (!version) {
      throw handymanCommercialAgreementVersionNotFoundError();
    }
    // Serialize on the agreement root: all authoring for one
    // agreement takes this lock first (PART 01 discipline).
    const locked = await agreementRepo.findAgreementByClientId(
      client,
      version.clientId,
      true,
    );
    if (!locked || locked.id !== version.agreementId) {
      throw handymanCommercialAgreementNotFoundError();
    }

    const replay = await repo.findBasisByIdempotencyKey(
      client,
      idempotencyKey,
    );
    if (replay) {
      if (replay.agreementVersionId !== agreementVersionId) {
        throw handymanLaborPricingKeyConflictError();
      }
      return { basis: replay, replayed: true };
    }

    if (version.status !== 'DRAFT') {
      throw handymanLaborPricingVersionNotDraftError(agreementVersionId);
    }

    const existing = await repo.findBasisByMode(
      client,
      version.id,
      modeStr,
    );
    if (existing) {
      throw handymanLaborPricingModeConflictError(version.id, modeStr);
    }

    const basis = await repo.insertBasis(client, {
      agreementVersionId: version.id,
      mode: modeStr,
      crewMode: crewModeStr,
      billableTimeBasis: basisStr,
      unitAmount,
      currency: currencyStr,
      idempotencyKey,
      createdByUserId: actor,
    });
    return { basis, replayed: false };
  });
}

/** The frozen basis set of one exact version — never "current". */
export async function listHandymanLaborPricingBasisForVersion(
  agreementVersionId: string,
): Promise<HandymanLaborPricingBasisRecord[]> {
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
  return repo.listBasisByVersion(getPool(), versionId);
}

/**
 * Fail-closed as-of resolution (frozen §4.5): client + asOf resolves
 * the EXACT effective agreement version through the PART 01
 * resolver; the version's frozen definition set is then read. A mode
 * with no definition is a bounded conflict — never a silent default
 * and never a SaaS-derived price.
 */
export async function resolveHandymanLaborPricingBasisAt(
  clientId: string,
  asOf: string,
  mode: string,
): Promise<HandymanLaborPricingBasisRecord> {
  const client = ensureUuid(clientId, 'clientId');
  if (!isHandymanLaborPricingMode(mode)) {
    throw handymanLaborPricingValidationError('mode');
  }
  const version = await resolveHandymanCommercialAgreementAt(
    client,
    asOf,
  );
  const basis = await repo.findBasisByMode(getPool(), version.id, mode);
  if (!basis) {
    throw handymanLaborPricingBasisNotEffectiveError(mode, asOf);
  }
  return basis;
}
