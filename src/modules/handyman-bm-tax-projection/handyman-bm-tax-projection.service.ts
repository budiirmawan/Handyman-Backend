import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { normalizeBmVerifiedCalculationInput } from '../handyman-bm-tax-case/handyman-bm-tax-case.service';
import type { BmVerifiedCalculationInput } from '../handyman-bm-tax-case';
import { cents, decimal, hash } from '../handyman-pph-calculation/handyman-pph-core';
import { calculateApprovedHandymanBmWithholdingInSnapshot } from '../handyman-pph-calculation/handyman-pph.service';
import { calculateApprovedHandymanBmPpnInSnapshot } from '../handyman-ppn-calculation/handyman-ppn.service';
import type { BmCommissionTaxProjection } from './handyman-bm-tax-projection.types';

const integrity=()=>new AppError({code:ERROR_CODES.HANDYMAN_BM_TAX_PROJECTION_INTEGRITY_ERROR,statusCode:409,
  message:'The independently verified tax components do not describe the same commission and determination.'});

/** Internal entry point: both existing calculators must see the exact same read-only MVCC snapshot. */
export async function calculateHandymanBmCommissionTaxProjectionInSnapshot(tx:PoolClient,actor:string,
  input:BmVerifiedCalculationInput):Promise<BmCommissionTaxProjection> {
  const n=normalizeBmVerifiedCalculationInput(input);
  const snapshotRequired=()=>new AppError({code:ERROR_CODES.HANDYMAN_BM_TAX_PROJECTION_SNAPSHOT_REQUIRED,statusCode:409,
    message:'An active repeatable-read, read-only transaction is required for the consolidated projection.'});
  // Session defaults alone do not make successive autocommit statements share an MVCC snapshot.
  if(tx.getTransactionStatus()!=='T') throw snapshotRequired();
  const mode=(await tx.query(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only`)).rows[0];
  if(tx.getTransactionStatus()!=='T' || mode.isolation!=='repeatable read' || mode.read_only!=='on') throw snapshotRequired();

  // Each calculator re-resolves the approved 0500 case and both tax sources; the same transaction fixes their view.
  const ppn=await calculateApprovedHandymanBmPpnInSnapshot(tx,actor,n);
  const pph=await calculateApprovedHandymanBmWithholdingInSnapshot(tx,actor,n);
  const pin=n.determination,source=ppn.source,determination=ppn.determination;
  if(stableJson(source)!==stableJson(pph.source) || stableJson(determination)!==stableJson(pph.determination) ||
    source.clientId!==n.clientId || source.entitlementId!==n.entitlementId || source.currency!=='IDR' ||
    ppn.currency!=='IDR' || pph.currency!=='IDR' || ppn.clientId!==n.clientId || pph.clientId!==n.clientId ||
    ppn.sourceAmount!==source.commissionGross || pph.commissionGross!==source.commissionGross ||
    ppn.supplier.counterpartyId!==source.beneficiary.counterpartyId || pph.beneficiaryTaxIdentity.counterpartyId!==source.beneficiary.counterpartyId ||
    ppn.supplier.verificationId!==source.beneficiary.verificationId || pph.beneficiaryTaxIdentity.verificationId!==source.beneficiary.verificationId ||
    determination.caseId!==pin.caseId || determination.version!==pin.version || determination.digest!==pin.digest ||
    determination.decisionId!==pin.decisionId || determination.decisionDigest!==pin.decisionDigest) throw integrity();

  // Only the composition is new. Each tax's basis, rate and rounding come exclusively from its existing calculator.
  const gross=cents(source.commissionGross),ppnAmount=cents(ppn.ppnAmount),withheld=cents(pph.pphWithheld);
  const projection=decimal(gross+ppnAmount-withheld);
  const normalized=Object.freeze({...n,determination:Object.freeze({...n.determination})});
  const body=Object.freeze({schema:'HANDYMAN_BM_COMMISSION_TAX_PROJECTION_V1' as const,authority:'READ_ONLY_PROJECTION' as const,
    input:normalized,inputChecksumAlgorithm:'SHA-256' as const,inputChecksum:hash(normalized),currency:'IDR' as const,
    commissionGross:source.commissionGross,ppnBasis:ppn.dppAmount,ppnAmount:ppn.ppnAmount,
    pphWithholdingBasis:pph.taxableWithholdingBasis,pphWithheld:pph.pphWithheld,netPayableProjection:projection,ppn,pph});
  return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
}

/** Re-resolve a pinned Finance determination without writing or authorizing financial facts. */
export async function calculateHandymanBmCommissionTaxProjection(actor:string,
  input:BmVerifiedCalculationInput):Promise<BmCommissionTaxProjection> {
  const n=normalizeBmVerifiedCalculationInput(input),tx=await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await calculateHandymanBmCommissionTaxProjectionInSnapshot(tx,actor,n);
    await tx.query('COMMIT');return result;
  } catch(err) { await tx.query('ROLLBACK').catch(()=>undefined);throw err; }
  finally { tx.release(); }
}
