import { getPool } from '../../database';
import { isValidUuid } from '../clients';
import {
  handymanChargeableAdditionalWorkNotFoundError,
  handymanChargeableAdditionalWorkRepository,
} from '../handyman-chargeable-additional-works';
import {
  handymanServiceWarrantyClaimNotFoundError,
  handymanServiceWarrantyClaimRepository,
} from '../handyman-service-warranty-claims';
import {
  handymanServiceWarrantyReworkNotFoundError,
  handymanServiceWarrantyReworkRepository,
} from '../handyman-service-warranty-reworks';
import {
  handymanServiceWarrantyNotFoundError,
  handymanServiceWarrantyRepository,
  handymanServiceWarrantyValidationError,
} from '../handyman-service-warranties';
import type { HandymanServiceWarrantyRecord }
  from '../handyman-service-warranties';
import {
  assertHandymanServiceWarrantyContractShape,
  assertHandymanServiceWarrantyContractSource,
} from './handyman-service-warranty-contract.firewall';
import {
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE,
  HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION,
} from './handyman-service-warranty-contract.types';
import type {
  HandymanServiceWarrantyContract,
  HandymanServiceWarrantyContractChargeableFact,
  HandymanServiceWarrantyContractClaimFact,
  HandymanServiceWarrantyContractReworkFact,
} from './handyman-service-warranty-contract.types';

/**
 * CR-HM-15 PART 05 — the published READ contract (FROZEN
 * `CR-HM-15_START_GOVERNANCE.md` §5/§6/§7/§8 row 05).
 *
 * SELECT-ONLY: every read below goes through the owning PART's own
 * repository/service read helper, and every status published is the
 * owner's vocabulary verbatim. This file defines no transition, asserts
 * no authority, publishes no command, writes nothing, computes no money,
 * and projects no FM/asset/SaaS warranty. Mutations stay with PART 01
 * (start/expire), PART 02 (claims), PART 03 (free rework) and PART 04
 * (chargeable separation).
 *
 * Addresses (CR-HM-17/18): warranty id, execution scope id, claim id,
 * rework id or chargeable-additional-work id — all resolve to the SAME
 * bounded contract for that one service warranty.
 */

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanServiceWarrantyValidationError(field);
  }
  return raw;
}

/** Builds the bounded projection from ONE warranty head (read-only). */
async function buildHandymanServiceWarrantyContract(
  warranty: HandymanServiceWarrantyRecord,
): Promise<HandymanServiceWarrantyContract> {
  const pool = getPool();
  const [coverages, claims, reworks, chargeables] = await Promise.all([
    handymanServiceWarrantyRepository.listCoverages(pool, warranty.id),
    handymanServiceWarrantyClaimRepository.listClaimsByWarrantyId(
      pool, warranty.id),
    handymanServiceWarrantyReworkRepository.listReworksByWarrantyId(
      pool, warranty.id),
    handymanChargeableAdditionalWorkRepository.listWorksByWarrantyId(
      pool, warranty.id),
  ]);

  const claimFacts: HandymanServiceWarrantyContractClaimFact[] = claims.map(
    (claim) => ({
      id: claim.id,
      status: claim.status,
      evidenceRecordId: claim.evidenceRecordId,
      claimNote: claim.claimNote,
      submittedAt: claim.submittedAt,
      decidedAt: claim.decidedAt,
      decisionNote: claim.decisionNote,
      withdrawnAt: claim.withdrawnAt,
      createdAt: claim.createdAt,
      reworkId: reworks.find((rework) => rework.claimId === claim.id)?.id
        ?? null,
      chargeableAdditionalWorkId: chargeables.find(
        (work) => work.claimId === claim.id)?.id ?? null,
    }),
  );
  const reworkFacts: HandymanServiceWarrantyContractReworkFact[] =
    reworks.map((rework) => ({
      id: rework.id,
      claimId: rework.claimId,
      status: rework.status,
      scopeNote: rework.scopeNote,
      proposedAt: rework.proposedAt,
      authorizedAt: rework.authorizedAt,
      startedAt: rework.startedAt,
      completedAt: rework.completedAt,
      verifiedAt: rework.verifiedAt,
      verificationEvidenceRecordId: rework.verificationEvidenceRecordId,
      verificationQcRunId: rework.verificationQcRunId,
    }));
  const chargeableFacts: HandymanServiceWarrantyContractChargeableFact[] =
    chargeables.map((work) => ({
      id: work.id,
      claimId: work.claimId,
      status: work.status,
      scopeNote: work.scopeNote,
      proposedAt: work.proposedAt,
      decidedAt: work.decidedAt,
      paymentTriggerEmittedAt: work.paymentTriggerEmittedAt,
    }));

  // Bounded to the LATEST row per family (the lists are oldest-first).
  const latestClaim = claimFacts.length > 0
    ? claimFacts[claimFacts.length - 1]
    : null;
  const latestRework = reworkFacts.length > 0
    ? reworkFacts[reworkFacts.length - 1]
    : null;
  const latestChargeable = chargeableFacts.length > 0
    ? chargeableFacts[chargeableFacts.length - 1]
    : null;

  const contract: HandymanServiceWarrantyContract = {
    contractVersion: HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION,
    contractSource: HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE,
    readOnly: true,
    warranty: {
      id: warranty.id,
      clientId: warranty.clientId,
      executionScopeId: warranty.executionScopeId,
      bastId: warranty.bastId,
      status: warranty.status,
      startsAt: warranty.startsAt,
      bastAcceptedAt: warranty.bastAcceptedAt,
      expiredAt: warranty.expiredAt,
      coverages: coverages.map((coverage) => ({
        coverageType: coverage.coverageType,
        coverageSince: coverage.createdAt,
      })),
    },
    claims: claimFacts,
    reworks: reworkFacts,
    chargeableAdditionalWorks: chargeableFacts,
    anchors: {
      clientId: warranty.clientId,
      executionScopeId: warranty.executionScopeId,
      bastId: warranty.bastId,
      warrantyId: warranty.id,
      claimId: latestClaim?.id ?? null,
      reworkId: latestRework?.id ?? null,
      chargeableAdditionalWorkId: latestChargeable?.id ?? null,
    },
    history: {
      // The BAST ACCEPTED instant IS the warranty start boundary
      // (PART 01 CHECK: starts_at = bast_accepted_at); the consumed BAST
      // and the whole service history stay the ORIGINAL ones.
      bastAcceptedAt: warranty.bastAcceptedAt,
      warrantyStartsAt: warranty.startsAt,
      warrantyExpiredAt: warranty.expiredAt,
      claimSubmittedAt: latestClaim?.submittedAt ?? null,
      claimDecidedAt: latestClaim?.decidedAt ?? null,
      reworkCompletedAt: latestRework?.completedAt ?? null,
      reworkVerifiedAt: latestRework?.verifiedAt ?? null,
      chargeableDecidedAt: latestChargeable?.decidedAt ?? null,
      paymentTriggerEmittedAt:
        latestChargeable?.paymentTriggerEmittedAt ?? null,
    },
    lifecycle: {
      warrantyStatus: warranty.status,
      claimStatus: latestClaim?.status ?? null,
      reworkStatus: latestRework?.status ?? null,
      chargeableAdditionalWorkStatus: latestChargeable?.status ?? null,
    },
    readiness: {
      warrantyStarted: warranty.status !== 'INELIGIBLE',
      warrantyExpired: warranty.status === 'EXPIRED',
      // PART 03 propose gate.
      freeReworkAvailable: latestClaim?.status === 'CLAIM_APPROVED'
        && warranty.status === 'CLAIM_APPROVED'
        && latestRework === null,
      freeReworkAwaitingCustomerDecision:
        latestRework?.status === 'REWORK_DRAFT',
      freeReworkClosed: latestRework?.status === 'REWORK_VERIFIED',
      // PART 04 intake + separation gate (approved/rejected pair, no
      // accepted-or-executed free rework, no referral yet).
      chargeablePathAvailable: (latestClaim?.status === 'CLAIM_APPROVED'
        || latestClaim?.status === 'CLAIM_REJECTED')
        && warranty.status === latestClaim?.status
        && (latestRework === null || latestRework.status === 'REWORK_DRAFT')
        && latestChargeable === null,
      chargeableAdditionalWorkAwaitingCustomerDecision:
        latestChargeable?.status === 'CHARGEABLE_PROPOSED',
      chargeableAdditionalWorkAuthorized:
        latestChargeable?.status === 'CHARGEABLE_AUTHORIZED',
      paymentTriggerEmitted:
        latestChargeable?.paymentTriggerEmittedAt !== null
        && latestChargeable?.paymentTriggerEmittedAt !== undefined,
    },
  };

  // Publish-time firewall: never emit an asset-warranty identity or a
  // money value, and always declare the service-warranty source.
  assertHandymanServiceWarrantyContractSource(contract.contractSource);
  assertHandymanServiceWarrantyContractShape(contract);
  return contract;
}

/** Contract addressed by the warranty head. */
export async function readHandymanServiceWarrantyContractByWarrantyId(
  warrantyIdRaw: string,
): Promise<HandymanServiceWarrantyContract> {
  const warrantyId = ensureUuid(warrantyIdRaw, 'warrantyId');
  const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
    getPool(),
    warrantyId,
  );
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  return buildHandymanServiceWarrantyContract(warranty);
}

/** Contract addressed by the ORIGINAL execution scope (CR-HM-17 view). */
export async function readHandymanServiceWarrantyContractByExecutionScopeId(
  executionScopeIdRaw: string,
): Promise<HandymanServiceWarrantyContract> {
  const executionScopeId = ensureUuid(executionScopeIdRaw, 'executionScopeId');
  const warranty = await handymanServiceWarrantyRepository
    .findWarrantyByExecutionScopeId(getPool(), executionScopeId);
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  return buildHandymanServiceWarrantyContract(warranty);
}

/** Contract addressed by one claim of the warranty. */
export async function readHandymanServiceWarrantyClaimContract(
  claimIdRaw: string,
): Promise<HandymanServiceWarrantyContract> {
  const claimId = ensureUuid(claimIdRaw, 'claimId');
  const claim = await handymanServiceWarrantyClaimRepository.findClaimById(
    getPool(),
    claimId,
  );
  if (!claim) throw handymanServiceWarrantyClaimNotFoundError();
  const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
    getPool(),
    claim.warrantyId,
  );
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  return buildHandymanServiceWarrantyContract(warranty);
}

/** Contract addressed by one free rework of the warranty. */
export async function readHandymanServiceWarrantyReworkContract(
  reworkIdRaw: string,
): Promise<HandymanServiceWarrantyContract> {
  const reworkId = ensureUuid(reworkIdRaw, 'reworkId');
  const rework = await handymanServiceWarrantyReworkRepository.findReworkById(
    getPool(),
    reworkId,
  );
  if (!rework) throw handymanServiceWarrantyReworkNotFoundError();
  const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
    getPool(),
    rework.warrantyId,
  );
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  return buildHandymanServiceWarrantyContract(warranty);
}

/** Contract addressed by one chargeable additional-work referral. */
export async function readHandymanChargeableAdditionalWorkContract(
  workIdRaw: string,
): Promise<HandymanServiceWarrantyContract> {
  const workId = ensureUuid(workIdRaw, 'workId');
  const work = await handymanChargeableAdditionalWorkRepository.findWorkById(
    getPool(),
    workId,
  );
  if (!work) throw handymanChargeableAdditionalWorkNotFoundError();
  const warranty = await handymanServiceWarrantyRepository.findWarrantyById(
    getPool(),
    work.warrantyId,
  );
  if (!warranty) throw handymanServiceWarrantyNotFoundError();
  return buildHandymanServiceWarrantyContract(warranty);
}
