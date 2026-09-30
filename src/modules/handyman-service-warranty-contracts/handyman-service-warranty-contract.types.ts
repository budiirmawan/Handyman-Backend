/**
 * CR-HM-15 PART 05 — PUBLISHED READ CONTRACT types (FROZEN
 * `CR-HM-15_START_GOVERNANCE.md` §5/§6/§7, §8 row 05).
 *
 * READ-ONLY publication for CR-HM-17/18 presentation consumption:
 * the bounded lifecycle/status of the four CR-HM-15 families, their
 * immutable ANCHORS (client / execution scope / BAST / warranty / claim /
 * rework / chargeable additional work) and non-authoritative READINESS
 * facts derived from the owners' frozen ladders.
 *
 * This module owns NO lifecycle: every status vocabulary below is
 * RE-EXPORTED FROM ITS OWNER (warranty PART 01, claim PART 02, rework
 * PART 03, chargeable additional work PART 04) and is never re-declared,
 * extended or re-interpreted here. It performs no writes, defines no
 * transition, publishes no command and adds no authority — mutations keep
 * going through the owning PARTs.
 *
 * FIRMWALLED (§5/§6/§7): no asset/vendor/FM/SaaS warranty projection is
 * ever treated as service-warranty truth, and no amount, price, currency,
 * ledger, payment or settlement value is ever published (CR-HM-13 owns
 * financial execution; this contract exposes at most the separation FACT
 * that a payment trigger was emitted).
 */

import type { HandymanChargeableAdditionalWorkStatus }
  from '../handyman-chargeable-additional-works';
import type { HandymanServiceWarrantyClaimStatus }
  from '../handyman-service-warranty-claims';
import type { HandymanServiceWarrantyReworkStatus }
  from '../handyman-service-warranty-reworks';
import type {
  HandymanServiceWarrantyCoverageType,
  HandymanServiceWarrantyStatus,
} from '../handyman-service-warranties';

/** Published contract version (bump = new contract, never a silent edit). */
export const HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION = '1' as const;

/** The ONLY contract source CR-HM-15 publishes; never FM/asset warranty. */
export const HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE =
  'HANDYMAN_SERVICE_WARRANTY' as const;

/** The four published families (owner authority in parentheses). */
export const HANDYMAN_SERVICE_WARRANTY_CONTRACT_FAMILIES = [
  'warranty',                  // CR-HM-15 PART 01
  'claim',                     // CR-HM-15 PART 02
  'rework',                    // CR-HM-15 PART 03
  'chargeableAdditionalWork',  // CR-HM-15 PART 04
] as const;

export type HandymanServiceWarrantyContractFamily =
  (typeof HANDYMAN_SERVICE_WARRANTY_CONTRACT_FAMILIES)[number];

export type HandymanServiceWarrantyContractCoverageFact = {
  coverageType: HandymanServiceWarrantyCoverageType;
  coverageSince: Date;
};

export type HandymanServiceWarrantyContractWarrantyFact = {
  id: string;
  clientId: string;
  executionScopeId: string;
  bastId: string;
  status: HandymanServiceWarrantyStatus;
  startsAt: Date;
  bastAcceptedAt: Date;
  expiredAt: Date | null;
  coverages: HandymanServiceWarrantyContractCoverageFact[];
};

export type HandymanServiceWarrantyContractClaimFact = {
  id: string;
  status: HandymanServiceWarrantyClaimStatus;
  evidenceRecordId: string | null;
  claimNote: string;
  submittedAt: Date | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  withdrawnAt: Date | null;
  createdAt: Date;
  reworkId: string | null;
  chargeableAdditionalWorkId: string | null;
};

export type HandymanServiceWarrantyContractReworkFact = {
  id: string;
  claimId: string;
  status: HandymanServiceWarrantyReworkStatus;
  scopeNote: string;
  proposedAt: Date;
  authorizedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  verifiedAt: Date | null;
  verificationEvidenceRecordId: string | null;
  verificationQcRunId: string | null;
};

export type HandymanServiceWarrantyContractChargeableFact = {
  id: string;
  claimId: string;
  status: HandymanChargeableAdditionalWorkStatus;
  scopeNote: string;
  proposedAt: Date;
  decidedAt: Date | null;
  /**
   * The CR-HM-13 separation FACT ("this authorized scope was published as
   * a payment trigger"). It carries NO amount, and CR-HM-13 owns every
   * pricing/ledger/payment/settlement concern.
   */
  paymentTriggerEmittedAt: Date | null;
};

/** Immutable identities: the BAST/service-history anchors. */
export type HandymanServiceWarrantyContractAnchors = {
  clientId: string;
  executionScopeId: string;
  bastId: string;
  warrantyId: string;
  claimId: string | null;
  reworkId: string | null;
  chargeableAdditionalWorkId: string | null;
};

/** Immutable instants (latest per family; null when that step never ran). */
export type HandymanServiceWarrantyContractHistory = {
  bastAcceptedAt: Date;
  warrantyStartsAt: Date;
  warrantyExpiredAt: Date | null;
  claimSubmittedAt: Date | null;
  claimDecidedAt: Date | null;
  reworkCompletedAt: Date | null;
  reworkVerifiedAt: Date | null;
  chargeableDecidedAt: Date | null;
  paymentTriggerEmittedAt: Date | null;
};

/** Bounded lifecycle: owner statuses ONLY, latest per family. */
export type HandymanServiceWarrantyContractLifecycle = {
  warrantyStatus: HandymanServiceWarrantyStatus;
  claimStatus: HandymanServiceWarrantyClaimStatus | null;
  reworkStatus: HandymanServiceWarrantyReworkStatus | null;
  chargeableAdditionalWorkStatus:
    HandymanChargeableAdditionalWorkStatus | null;
};

/**
 * READINESS facts — pure projections of the owners' frozen guards. They
 * are NOT authority: a client that wants to act still calls the owning
 * PART's command, which re-proves everything.
 */
export type HandymanServiceWarrantyContractReadiness = {
  /** Warranty started (an ACCEPTED BAST exists). */
  warrantyStarted: boolean;
  warrantyExpired: boolean;
  /** PART 03 propose gate holds (APPROVED claim + CLAIM_APPROVED head). */
  freeReworkAvailable: boolean;
  /** A proposed free scope is waiting for the customer-side acceptor. */
  freeReworkAwaitingCustomerDecision: boolean;
  /** The free rework reached REWORK_VERIFIED (the claim closure fact). */
  freeReworkClosed: boolean;
  /** PART 04 intake + separation gate holds (APPROVED or REJECTED pair). */
  chargeablePathAvailable: boolean;
  /** A chargeable scope is waiting for the customer-side acceptor. */
  chargeableAdditionalWorkAwaitingCustomerDecision: boolean;
  /** The customer accepted the separated chargeable scope. */
  chargeableAdditionalWorkAuthorized: boolean;
  /** The CR-HM-13 payment trigger fact was emitted (no amount here). */
  paymentTriggerEmitted: boolean;
};

/** The published, versioned, read-only CR-HM-15 contract. */
export type HandymanServiceWarrantyContract = {
  contractVersion: typeof HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION;
  contractSource: typeof HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE;
  readOnly: true;
  warranty: HandymanServiceWarrantyContractWarrantyFact;
  claims: HandymanServiceWarrantyContractClaimFact[];
  reworks: HandymanServiceWarrantyContractReworkFact[];
  chargeableAdditionalWorks:
    HandymanServiceWarrantyContractChargeableFact[];
  anchors: HandymanServiceWarrantyContractAnchors;
  history: HandymanServiceWarrantyContractHistory;
  lifecycle: HandymanServiceWarrantyContractLifecycle;
  readiness: HandymanServiceWarrantyContractReadiness;
};
