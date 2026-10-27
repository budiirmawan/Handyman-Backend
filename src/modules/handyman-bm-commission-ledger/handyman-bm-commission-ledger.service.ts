import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import type { BmTaxCasePin, BmVerifiedCalculationInput } from '../handyman-bm-tax-case';
import { accessBmTaxCase, lockBmTaxPostingScopeAndLedger, normalizeBmVerifiedCalculationInput, readBmTaxNow }
  from '../handyman-bm-tax-case/handyman-bm-tax-case.service';
import { calculateHandymanBmCommissionTaxProjectionInLockedTransaction }
  from '../handyman-bm-tax-projection/handyman-bm-tax-projection.service';
import { calculateHandymanBmCorrectedTaxProjectionInLockedTransaction }
  from '../handyman-bm-correction-tax/handyman-bm-correction-tax.service';
import { cents, decimal, hash, uuid } from '../handyman-pph-calculation/handyman-pph-core';

export type PostBmCommissionLedgerInput = Readonly<{
  clientId:string; entitlementId:string; correctionFactId?:string|null;
  determination:BmTaxCasePin; idempotencyKey:string;
}>;
type Amounts=Readonly<{gross:string;ppn:string;pph:string;net:string}>;

const conflict=(message='The commission ledger entry or idempotency key conflicts.')=>
  new AppError({code:ERROR_CODES.HANDYMAN_BM_COMMISSION_LEDGER_CONFLICT,statusCode:409,message});
const witness=(entitlementId:string,correctionFactId:string)=>new AppError({
  code:ERROR_CODES.HANDYMAN_BM_COMMISSION_LEDGER_WITNESS_REQUIRED,statusCode:409,
  message:`Correction ${correctionFactId} requires a pre-correction original commission ledger witness for entitlement ${entitlementId}.`,
});
const forecast=()=>new AppError({code:ERROR_CODES.HANDYMAN_BM_COMMISSION_LEDGER_FORECAST,statusCode:409,
  message:'Future PPN or PPh tax points are forecasts, not postable tax-event evidence.'});
const signed=(value:bigint)=>value<0n?`-${decimal(-value)}`:decimal(value);
function normalize(value:PostBmCommissionLedgerInput) {
  if(!value || typeof value!=='object' || Array.isArray(value) ||
     Object.keys(value).some(k=>!['clientId','entitlementId','correctionFactId','determination','idempotencyKey'].includes(k)))
    throw AppError.validation('Invalid commission ledger request.');
  if(typeof value.idempotencyKey!=='string' || !value.idempotencyKey || value.idempotencyKey!==value.idempotencyKey.trim() ||
     value.idempotencyKey.length>200 || /[\u0000-\u001f\u007f]/.test(value.idempotencyKey))
    throw AppError.validation('Invalid idempotencyKey.');
  const base=normalizeBmVerifiedCalculationInput({clientId:value.clientId,entitlementId:value.entitlementId,determination:value.determination});
  return {...base,correctionFactId:value.correctionFactId==null?null:uuid(value.correctionFactId,'correctionFactId'),idempotencyKey:value.idempotencyKey};
}
function map(row:any,replayed=false) {
  return Object.freeze({snapshot:row.snapshot as BmCommissionLedgerSnapshot,digestAlgorithm:'SHA-256' as const,
    digest:row.digest as string,createdAt:(row.created_at as Date).toISOString(),replayed});
}

/** Immutable snapshot; the PPh amount is a calculation, not evidence of withholding. */
export type BmCommissionLedgerSnapshot=Readonly<{
  schema:'HANDYMAN_BM_COMMISSION_LEDGER_V1'; id:string; clientId:string; buildingId:string; counterpartyId:string;
  entitlementId:string; correctionFactId:string|null; previousEntryId:string|null;
  entryType:'ORIGINAL'|'CORRECTION_ADJUSTMENT'; sequence:1|2; currency:'IDR';
  approval:BmTaxCasePin; sourceChecksum:string; projectionChecksum:string; intentChecksum:string;
  idempotencyKey:string; createdByUserId:string; amounts:Amounts; delta:Amounts;
  assertions:Readonly<{withholding:'NOT_ASSERTED';remittance:'NOT_ASSERTED';payment:'NOT_ASSERTED'}>;
  projection:unknown;
}>;

/** Revalidate and post a calculation only; this does not authorize settlement, remittance or payout. */
export async function postHandymanBmCommissionLedger(actorInput:string,input:PostBmCommissionLedgerInput) {
  const actor=uuid(actorInput,'actorUserId'),n=normalize(input);
  const intentChecksum=hash({schema:'HANDYMAN_BM_COMMISSION_LEDGER_INTENT_V1',actor,
    clientId:n.clientId,entitlementId:n.entitlementId,correctionFactId:n.correctionFactId,determination:n.determination});
  try {return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const buildingId=await accessBmTaxCase(tx,actor,n.clientId,n.entitlementId,'maker');
    await lockBmTaxPostingScopeAndLedger(tx,n.clientId,n.entitlementId);
    const replay=(await tx.query('SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 AND idempotency_key=$2',
      [n.entitlementId,n.idempotencyKey])).rows[0];
    if(replay) {
      if(replay.intent_checksum!==intentChecksum || replay.created_by_user_id!==actor) throw conflict();
      return map(replay,true);
    }
    const prior=(await tx.query('SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 ORDER BY sequence DESC LIMIT 1',
      [n.entitlementId])).rows[0];
    if(n.correctionFactId && !prior) throw witness(n.entitlementId,n.correctionFactId);
    if((!n.correctionFactId && prior) || (n.correctionFactId && prior?.entry_type!=='ORIGINAL'))
      throw conflict('An entry already exists for this original entitlement or correction.');

    const base:BmVerifiedCalculationInput={clientId:n.clientId,entitlementId:n.entitlementId,determination:n.determination};
    let projection:Awaited<ReturnType<typeof calculateHandymanBmCommissionTaxProjectionInLockedTransaction>> |
      Awaited<ReturnType<typeof calculateHandymanBmCorrectedTaxProjectionInLockedTransaction>>;
    let sourceChecksum:string,counterpartyId:string,originalPin:BmTaxCasePin;
    if(n.correctionFactId) {
      const p=await calculateHandymanBmCorrectedTaxProjectionInLockedTransaction(tx,actor,{...base,correctionFactId:n.correctionFactId});
      if(p.source.originalSourceChecksum!==prior.source_checksum || stableJson(p.source.baseline)!==stableJson(prior.snapshot.approval))
        throw conflict('The approved correction baseline does not match the original ledger witness.');
      projection=p;sourceChecksum=p.source.checksum;counterpartyId=p.source.beneficiary.counterpartyId;originalPin=p.source.baseline;
    } else {
      const p=await calculateHandymanBmCommissionTaxProjectionInLockedTransaction(tx,actor,base);
      projection=p;sourceChecksum=p.ppn.source.checksum;counterpartyId=p.ppn.source.beneficiary.counterpartyId;originalPin=n.determination;
    }
    // A future assertion remains a forecast even when independently approved.
    const now=Date.parse(await readBmTaxNow(tx));
    if(Date.parse(projection.ppn.taxPointAt)>now || Date.parse(projection.pph.taxPointAt)>now) throw forecast();
    const net='netPayableProjection' in projection?projection.netPayableProjection:projection.netCommissionProjection;
    const amounts:Amounts={gross:projection.commissionGross,ppn:projection.ppnAmount,pph:projection.pphWithheld,net};
    const previous:Amounts=prior?{gross:prior.gross,ppn:prior.ppn,pph:prior.pph_withholding_projection,net:prior.net_payable}:
      {gross:'0.00',ppn:'0.00',pph:'0.00',net:'0.00'};
    const delta:Amounts={gross:signed(cents(amounts.gross)-cents(previous.gross)),ppn:signed(cents(amounts.ppn)-cents(previous.ppn)),
      pph:signed(cents(amounts.pph)-cents(previous.pph)),net:signed(cents(amounts.net)-cents(previous.net))};
    const entryType=n.correctionFactId?'CORRECTION_ADJUSTMENT' as const:'ORIGINAL' as const;
    const sequence=n.correctionFactId?2 as const:1 as const;
    const snapshot:BmCommissionLedgerSnapshot={schema:'HANDYMAN_BM_COMMISSION_LEDGER_V1',id:randomUUID(),clientId:n.clientId,buildingId,
      counterpartyId,entitlementId:n.entitlementId,correctionFactId:n.correctionFactId,previousEntryId:prior?.id??null,entryType,sequence,currency:'IDR',
      approval:n.determination,sourceChecksum,projectionChecksum:projection.checksum,intentChecksum,idempotencyKey:n.idempotencyKey,
      createdByUserId:actor,amounts,delta,assertions:{withholding:'NOT_ASSERTED',remittance:'NOT_ASSERTED',payment:'NOT_ASSERTED'},projection};
    const result=await tx.query(`INSERT INTO handyman_bm_commission_ledger
      (id,client_id,building_id,counterparty_id,entitlement_id,correction_id,original_case_id,original_decision_id,
       correction_case_id,correction_decision_id,previous_entry_id,entry_type,sequence,gross,ppn,pph_withholding_projection,net_payable,
       gross_delta,ppn_delta,pph_delta,net_delta,source_checksum,projection_checksum,intent_checksum,idempotency_key,snapshot,digest,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING *`,
      [snapshot.id,n.clientId,buildingId,counterpartyId,n.entitlementId,n.correctionFactId,originalPin.caseId,originalPin.decisionId,
       n.correctionFactId?n.determination.caseId:null,n.correctionFactId?n.determination.decisionId:null,snapshot.previousEntryId,entryType,sequence,
       amounts.gross,amounts.ppn,amounts.pph,amounts.net,delta.gross,delta.ppn,delta.pph,delta.net,sourceChecksum,projection.checksum,
       intentChecksum,n.idempotencyKey,JSON.stringify(snapshot),hash(snapshot),actor]);
    return map(result.rows[0]);
  });} catch(error) {
    if(error instanceof AppError) throw error;
    if(['23503','23505','23514','22P02','40001','40P01'].includes((error as {code?:string})?.code??'')) throw conflict();
    throw error;
  }
}

/** Scoped Finance history; immutable rows are never recomputed or silently replaced. */
export async function readHandymanBmCommissionLedger(actorInput:string,input:{clientId:string;entitlementId:string}) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['clientId','entitlementId'].includes(k)))
    throw AppError.validation('Invalid commission ledger request.');
  const actor=uuid(actorInput,'actorUserId'),clientId=uuid(input.clientId,'clientId'),entitlementId=uuid(input.entitlementId,'entitlementId');
  return withTransaction(async tx=>{
    await accessBmTaxCase(tx,actor,clientId,entitlementId,'read');
    const rows=await tx.query('SELECT * FROM handyman_bm_commission_ledger WHERE client_id=$1 AND entitlement_id=$2 ORDER BY sequence',
      [clientId,entitlementId]);
    return rows.rows.map(row=>map(row));
  });
}
