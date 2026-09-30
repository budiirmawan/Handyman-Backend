/**
 * CR-HM-15 PART 05 — Asset-Warranty FIREWALL for the published contract
 * (FROZEN `CR-HM-15_START_GOVERNANCE.md` §5/§6/§7/§9, blocker B4/B7).
 *
 * The published contract is SERVICE-warranty truth only:
 *
 *   session COMPLETE != Warranty Start   (CR-HM-08)
 *   CHECK_OUT        != Warranty Start
 *   BAST ACCEPTED    == Warranty Start   (ONLY eligibility, CR-HM-11)
 *   QC PASS          != Warranty Start   (CR-HM-10)
 *   Asset Warranty   != Handyman Service Warranty
 *
 * An FM / asset / vendor / SaaS warranty is never a source of this
 * contract, never a projection behind it and never its truth. These are
 * PUBLICATION-TIME checks (pure functions, no writes, no authority):
 * they refuse to publish a projection that would carry asset-warranty
 * identity or a money value.
 */

import {
  handymanServiceWarrantyValidationError,
  HANDYMAN_SERVICE_WARRANTY_START_SOURCES,
  HANDYMAN_NOT_SERVICE_WARRANTY_START,
} from '../handyman-service-warranties';
import { HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE }
  from './handyman-service-warranty-contract.types';

/** The frozen separations republished verbatim for CR-HM-17/18. */
export const HANDYMAN_ASSET_WARRANTY_FIREWALL = [
  'SESSION_COMPLETE != WARRANTY_START (CR-HM-08)',
  'CHECK_OUT != WARRANTY_START (CR-HM-08)',
  'BAST_ACCEPTED == WARRANTY_START (CR-HM-11)',
  'QC_PASS != WARRANTY_START (CR-HM-10)',
  'ASSET_WARRANTY != HANDYMAN_SERVICE_WARRANTY (CR-HM-15)',
] as const;

/**
 * Sources that may NEVER be projected as service-warranty truth. The only
 * admitted source is `HANDYMAN_SERVICE_WARRANTY`, and the only admitted
 * start source is the ACCEPTED BAST (CR-HM-11).
 */
export const HANDYMAN_NOT_SERVICE_WARRANTY_CONTRACT_SOURCE = [
  'FM_ASSET_WARRANTY',
  'ASSET_WARRANTY',
  'VENDOR_WARRANTY',
  'SAAS_WARRANTY',
] as const;

export type HandymanNotServiceWarrantyContractSource =
  (typeof HANDYMAN_NOT_SERVICE_WARRANTY_CONTRACT_SOURCE)[number];

export function isNotServiceWarrantyContractSourceAlias(
  value: string,
): value is HandymanNotServiceWarrantyContractSource {
  return (HANDYMAN_NOT_SERVICE_WARRANTY_CONTRACT_SOURCE as readonly string[])
    .includes(value);
}

/**
 * Publication gate: the contract source must be the Handyman SERVICE
 * warranty. An FM/asset/vendor/SaaS warranty can never publish here.
 */
export function assertHandymanServiceWarrantyContractSource(
  source: string,
): void {
  if (source === HANDYMAN_SERVICE_WARRANTY_CONTRACT_SOURCE) return;
  throw handymanServiceWarrantyValidationError(`contractSource=${source}`);
}

/**
 * Publication gate: the warranty start source must be the ACCEPTED BAST
 * (CR-HM-11). Session COMPLETE, CHECK_OUT, QC PASS and quotation
 * approval can never appear as a warranty start.
 */
export function assertHandymanServiceWarrantyContractStartSource(
  source: string,
): void {
  if (source === 'BAST_ACCEPTED') return;
  if ((HANDYMAN_NOT_SERVICE_WARRANTY_START as readonly string[])
    .includes(source)) {
    throw handymanServiceWarrantyValidationError(`startSource=${source}`);
  }
  if (!(HANDYMAN_SERVICE_WARRANTY_START_SOURCES as readonly string[])
    .includes(source)) {
    throw handymanServiceWarrantyValidationError(`startSource=${source}`);
  }
}

/** Money vocabulary that can never appear in a published projection. */
export const HANDYMAN_SERVICE_WARRANTY_CONTRACT_FORBIDDEN_KEY_PATTERN =
  /(amount|price|currency|ledger|settle|invoice|entitlement|tax|discount)/i;

/** Asset/FM/vendor/SaaS vocabulary that can never appear as a key. */
export const HANDYMAN_SERVICE_WARRANTY_CONTRACT_FORBIDDEN_ASSET_PATTERN =
  /^(fm|asset|saas|vendor)/i;

function scanProjection(
  value: unknown,
  path: string,
  seen: Set<unknown>,
): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanProjection(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (HANDYMAN_SERVICE_WARRANTY_CONTRACT_FORBIDDEN_KEY_PATTERN.test(key)) {
      throw handymanServiceWarrantyValidationError(`forbiddenKey=${path}${key}`);
    }
    if (HANDYMAN_SERVICE_WARRANTY_CONTRACT_FORBIDDEN_ASSET_PATTERN.test(key)) {
      throw handymanServiceWarrantyValidationError(
        `forbiddenAssetKey=${path}${key}`,
      );
    }
    if (key === 'contractSource' && typeof child === 'string') {
      assertHandymanServiceWarrantyContractSource(child);
    }
    scanProjection(child, `${path}${key}.`, seen);
  }
}

/**
 * Publication gate: the projection must stay inside the published shape.
 * Any amount/price/currency/ledger/settlement/entitlement value, any
 * asset/FM/vendor/SaaS key and any non-service contract source refuses to
 * publish (B4/B7, §9 "no pricing, no ledger").
 */
export function assertHandymanServiceWarrantyContractShape(
  projection: unknown,
): void {
  scanProjection(projection, '', new Set<unknown>());
}
