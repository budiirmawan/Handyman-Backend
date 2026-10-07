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
import { getHandymanMaterialFinalChargeReadyProjection }
  from '../handyman-material-execution';
import type { HandymanMaterialFinalUsedByUom }
  from '../handyman-material-execution';
import {
  handymanExecutionScopeRepository,
  listHandymanQuotationVersionLines,
} from '../handyman-quotations';
import {
  handymanMaterialPricingAlreadyDefinedError,
  handymanMaterialPricingBasisNotEffectiveError,
  handymanMaterialPricingCompositionError,
  handymanMaterialPricingKeyConflictError,
  handymanMaterialPricingVersionNotDraftError,
  handymanMaterialPricingValidationError,
} from './handyman-material-pricing.errors';
import {
  evaluateHandymanMaterialPricingBasis,
} from './handyman-material-pricing.evaluate';
import { handymanMaterialPricingRepository as repo }
  from './handyman-material-pricing.repository';
import type {
  HandymanMaterialPricingBasisEvaluation,
  HandymanMaterialPricingBasisRecord,
  HandymanMaterialPricingLineInput,
} from './handyman-material-pricing.types';
import { isHandymanMaterialPricingMode } from './handyman-material-pricing.types';

/**
 * CR-HM-12 PART 03 — material pricing basis authoring, fail-closed
 * resolution, and the READ-ONLY composition that consumes the
 * certified CR-HM-09 FINAL_CHARGE_READY handoff + the CR-HM-06
 * approved MATERIAL line snapshot (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §6/§10 PART 03).
 *
 * Zero writes outside this module's own append-only table; zero
 * ledger, zero BM-fee rules (PART 04), zero API. The basis output is
 * a MATERIAL-quantified fact for governed consumption — never a
 * final transaction charge (that decision is CR-HM-13's) and never
 * merged with LABOR (B10).
 */

export type HandymanMaterialPricingBasisPrepareInput = {
  agreementVersionId: string;
  mode: string;
  idempotencyKey: string;
};

export type HandymanMaterialPricingBasisPrepareResult = {
  basis: HandymanMaterialPricingBasisRecord;
  replayed: boolean;
};

export type HandymanMaterialPricingBasisForScope = {
  executionScopeId: string;
  agreementVersionId: string;
  mode: HandymanMaterialPricingBasisRecord['mode'];
  basis: HandymanMaterialPricingBasisEvaluation;
  finalUsedByUom: HandymanMaterialFinalUsedByUom[];
};

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanMaterialPricingValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanMaterialPricingValidationError('idempotencyKey');
  }
  return raw;
}

export async function prepareHandymanMaterialPricingBasis(
  actorUserId: string,
  input: HandymanMaterialPricingBasisPrepareInput,
): Promise<HandymanMaterialPricingBasisPrepareResult> {
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const agreementVersionId = ensureUuid(
    input.agreementVersionId,
    'agreementVersionId',
  );
  const idempotencyKey = ensureKey(input.idempotencyKey);
  const modeRaw = typeof input.mode === 'string'
    ? input.mode.trim()
    : '';
  if (!isHandymanMaterialPricingMode(modeRaw)) {
    throw handymanMaterialPricingValidationError('mode');
  }
  const mode = modeRaw;

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

    const replay = await repo.findBasisByIdempotencyKey(
      client,
      idempotencyKey,
    );
    if (replay) {
      if (replay.agreementVersionId !== agreementVersionId) {
        throw handymanMaterialPricingKeyConflictError();
      }
      return { basis: replay, replayed: true };
    }

    if (version.status !== 'DRAFT') {
      throw handymanMaterialPricingVersionNotDraftError(
        agreementVersionId,
      );
    }

    const existing = await repo.findBasisByVersion(client, version.id);
    if (existing) {
      throw handymanMaterialPricingAlreadyDefinedError(version.id);
    }

    const basis = await repo.insertBasis(client, {
      agreementVersionId: version.id,
      mode,
      idempotencyKey,
      createdByUserId: actor,
    });
    return { basis, replayed: false };
  });
}

export async function getHandymanMaterialPricingBasisForVersion(
  agreementVersionId: string,
): Promise<HandymanMaterialPricingBasisRecord | null> {
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
  return repo.findBasisByVersion(getPool(), versionId);
}

/**
 * Fail-closed as-of resolution of the definition itself (§4.5/§5):
 * client + asOf resolve the EXACT effective agreement version; the
 * version's single material basis must exist on it — never "latest"
 * and never another version's rule.
 */
export async function resolveHandymanMaterialPricingBasisAt(
  clientId: string,
  asOf: string,
): Promise<HandymanMaterialPricingBasisRecord> {
  const client = ensureUuid(clientId, 'clientId');
  const instant = parseHandymanAgreementTimestamp(asOf, 'asOf');
  const version = await resolveHandymanCommercialAgreementAt(
    client,
    instant.toISOString(),
  );
  const basis = await repo.findBasisByVersion(getPool(), version.id);
  if (!basis) {
    throw handymanMaterialPricingBasisNotEffectiveError(
      instant.toISOString(),
    );
  }
  return basis;
}

/**
 * READ-ONLY scope composition (frozen §6/§8.3): the CR-HM-09
 * FINAL_CHARGE_READY projection provides the settled QUANTITIES;
 * the CR-HM-06 approved MATERIAL snapshot provides the unit
 * amounts; the effective agreement version's basis mode chooses
 * which quantity applies. Nothing here writes or re-authors either
 * source; a missing/foreign linkage is a bounded composition
 * failure, never a fabricated fact.
 */
export async function computeHandymanMaterialPricingBasisForScope(
  executionScopeId: string,
  asOf: string,
  actorUserId: string,
): Promise<HandymanMaterialPricingBasisForScope> {
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  const actor = ensureUuid(actorUserId, 'actorUserId');

  const scope = await handymanExecutionScopeRepository.findScopeById(
    getPool(),
    scopeId,
  );
  if (!scope) {
    throw handymanMaterialPricingCompositionError('scope_unknown');
  }

  let basis: HandymanMaterialPricingBasisRecord;
  try {
    basis = await resolveHandymanMaterialPricingBasisAt(
      scope.clientId,
      asOf,
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      throw error;
    }
    throw handymanMaterialPricingCompositionError('basis_unresolved');
  }

  const projection = await getHandymanMaterialFinalChargeReadyProjection(
    scopeId,
    actor,
  );
  const snapshotLines = await listHandymanQuotationVersionLines(
    scope.approvedQuotationVersionId,
    actor,
  );
  const materialByLine = new Map(
    snapshotLines
      .filter((line) => line.lineType === 'MATERIAL')
      .map((line) => [line.id, line]),
  );

  const inputs: HandymanMaterialPricingLineInput[] = [];
  for (const settled of projection.lines) {
    const quotationLineId = settled.materialIdentity.quotationLineId;
    const snapshot = materialByLine.get(quotationLineId);
    if (!snapshot) {
      throw handymanMaterialPricingCompositionError(
        'snapshot_link_missing',
      );
    }
    inputs.push({
      quotationLineId,
      materialExecutionLineId: settled.id,
      finalQuotedUnitAmount: snapshot.finalQuotedUnitAmount.toFixed(2),
      currency: snapshot.currency,
      approvedQty: settled.approvedQty,
      finalUsedQty: settled.finalUsedQty,
    });
  }

  if (inputs.length === 0) {
    return {
      executionScopeId: scopeId,
      agreementVersionId: basis.agreementVersionId,
      mode: basis.mode,
      basis: {
        mode: basis.mode,
        currency: null,
        lines: [],
        basisAmount: '0.00',
      },
      finalUsedByUom: projection.finalUsedByUom,
    };
  }

  const evaluation = evaluateHandymanMaterialPricingBasis(
    basis.mode,
    inputs,
  );
  return {
    executionScopeId: scopeId,
    agreementVersionId: basis.agreementVersionId,
    mode: basis.mode,
    basis: evaluation,
    finalUsedByUom: projection.finalUsedByUom,
  };
}
