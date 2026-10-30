import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertHandymanQuotationPricingAuthority, assertQuotationThreadBuildingAccess } from './handyman-quotation-access';
import { handymanQuotationRepository } from './handyman-quotation.repository';
import { handymanQuotationNotFoundError, handymanQuotationVersionNotDraftError, handymanQuotationVersionNotFoundError } from './handyman-quotation.errors';

export const QUOTATION_WARRANTY_PROTOCOL = 'HANDYMAN_QUOTATION_LINE_WARRANTY_V1' as const;
export const VARIATION_WARRANTY_PROTOCOL = 'HANDYMAN_VARIATION_LINE_WARRANTY_V1' as const;
export type WarrantyTerms = {
  coverage: 'NONE' | 'LABOR' | 'PARTS' | 'BOTH';
  coveredServices: string | null;
  coveredMaterials: string | null;
  conditions: string | null;
  exclusions: string | null;
  commencementRule: 'BAST_ACCEPTED_AT' | null;
  endRule: 'DURATION_DAYS' | 'FIXED_END_DATE_JAKARTA' | null;
  durationDays: number | null;
  fixedEndDate: string | null;
};
export type AuthoredWarranty = { warrantyTerms: WarrantyTerms; replacesQuotationLineId: string | null };

const fields = ['coverage','coveredServices','coveredMaterials','conditions','exclusions','commencementRule','endRule','durationDays','fixedEndDate','replacesQuotationLineId'];
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw AppError.validation(`${field} must be explicit text of at most ${max} characters, without control characters.`);
  }
  return value.trim();
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value < '0001-01-01' || value > '9999-12-31' ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) {
    throw AppError.validation('fixedEndDate must be a real YYYY-MM-DD date.');
  }
  return value;
}
export function parseWarrantyTerms(input: unknown): AuthoredWarranty {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw AppError.validation('Explicit warranty terms are required.');
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(key => !fields.includes(key))) throw AppError.validation('Unknown warranty term field.');
  if (!['NONE','LABOR','PARTS','BOTH'].includes(String(v.coverage)) || typeof v.coverage !== 'string') {
    throw AppError.validation('coverage must be NONE, LABOR, PARTS or BOTH.');
  }
  const replacement = v.replacesQuotationLineId;
  if (replacement != null && (typeof replacement !== 'string' || !isValidUuid(replacement))) {
    throw AppError.validation('replacesQuotationLineId must identify the exact previous line.');
  }
  const replacesQuotationLineId = typeof replacement === 'string' ? replacement.toLowerCase() : null;
  if (v.coverage === 'NONE') {
    if (['coveredServices','coveredMaterials','conditions','exclusions','commencementRule','endRule','durationDays','fixedEndDate'].some(key => v[key] != null)) {
      throw AppError.validation('NONE cannot carry covered items, duration, conditions or exclusions.');
    }
    return { replacesQuotationLineId, warrantyTerms: { coverage: 'NONE', coveredServices: null, coveredMaterials: null, conditions: null, exclusions: null,
      commencementRule: null, endRule: null, durationDays: null, fixedEndDate: null } };
  }
  if (v.commencementRule !== 'BAST_ACCEPTED_AT') throw AppError.validation('commencementRule must be BAST_ACCEPTED_AT.');
  if (v.endRule !== 'DURATION_DAYS' && v.endRule !== 'FIXED_END_DATE_JAKARTA') throw AppError.validation('An explicit supported endRule is required.');
  let durationDays: number | null = null, fixedEndDate: string | null = null;
  if (v.endRule === 'DURATION_DAYS') {
    if (typeof v.durationDays !== 'number' || !Number.isInteger(v.durationDays) || v.durationDays < 1 || v.durationDays > 36500 || v.fixedEndDate != null) {
      throw AppError.validation('DURATION_DAYS requires integer durationDays (1–36500), and no fixedEndDate.');
    }
    durationDays = v.durationDays;
  } else {
    if (v.durationDays != null) throw AppError.validation('FIXED_END_DATE_JAKARTA cannot include durationDays.');
    fixedEndDate = date(v.fixedEndDate);
  }
  const coveredServices = v.coverage === 'LABOR' || v.coverage === 'BOTH' ? text(v.coveredServices, 'coveredServices', 800) : null;
  const coveredMaterials = v.coverage === 'PARTS' || v.coverage === 'BOTH' ? text(v.coveredMaterials, 'coveredMaterials', 800) : null;
  if ((coveredServices === null && v.coveredServices != null) || (coveredMaterials === null && v.coveredMaterials != null)) {
    throw AppError.validation('Covered services/materials must match the selected coverage.');
  }
  return { replacesQuotationLineId, warrantyTerms: { coverage: v.coverage as WarrantyTerms['coverage'],
    coveredServices, coveredMaterials, conditions: text(v.conditions, 'conditions', 1000),
    exclusions: text(v.exclusions, 'exclusions', 1000), commencementRule: 'BAST_ACCEPTED_AT',
    endRule: v.endRule, durationDays, fixedEndDate } };
}

/** Operations authors a proposal only; no consent or effective coverage is implied. */
export async function setHandymanQuotationLineWarrantyTerms(versionId: string, lineId: string, input: unknown, actorUserId: string) {
  if (![versionId,lineId,actorUserId].every(isValidUuid)) throw AppError.validation('Valid quotation, line and actor IDs are required.');
  const { warrantyTerms: w, replacesQuotationLineId } = parseWarrantyTerms(input);
  return withTransaction(async (tx: PoolClient) => {
    const version = await handymanQuotationRepository.lockVersionById(tx, versionId);
    if (!version) throw handymanQuotationVersionNotFoundError();
    const quotation = await handymanQuotationRepository.findQuotationById(tx, version.quotationId);
    if (!quotation) throw handymanQuotationNotFoundError();
    await assertQuotationThreadBuildingAccess(tx, quotation, actorUserId);
    const active = await tx.query<{ status: string }>('SELECT status FROM users WHERE id=$1', [actorUserId]);
    if (active.rows[0]?.status !== 'ACTIVE') throw new AppError({ statusCode: 403, code: 'PERMISSION_DENIED', message: 'Active Operations user required.' });
    await assertHandymanQuotationPricingAuthority({ clientId: quotation.clientId, handymanRequestId: quotation.handymanRequestId, actorUserId }, tx);
    if (version.status !== 'DRAFT') throw handymanQuotationVersionNotDraftError();
    const result = await tx.query(`INSERT INTO handyman_quotation_line_warranty_terms
      (quotation_line_id,quotation_version_id,coverage,covered_services,covered_materials,conditions,exclusions,commencement_rule,end_rule,duration_days,fixed_end_date,replaces_quotation_line_id,authored_by_user_id)
      SELECT l.id,l.quotation_version_id,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::uuid,$13 FROM handyman_quotation_lines l
      WHERE l.id=$2 AND l.quotation_version_id=$1
      ON CONFLICT (quotation_line_id) DO UPDATE SET coverage=EXCLUDED.coverage,covered_services=EXCLUDED.covered_services,
        covered_materials=EXCLUDED.covered_materials,
        conditions=EXCLUDED.conditions,exclusions=EXCLUDED.exclusions,commencement_rule=EXCLUDED.commencement_rule,
        end_rule=EXCLUDED.end_rule,duration_days=EXCLUDED.duration_days,fixed_end_date=EXCLUDED.fixed_end_date,
        replaces_quotation_line_id=EXCLUDED.replaces_quotation_line_id,authored_by_user_id=EXCLUDED.authored_by_user_id,updated_at=clock_timestamp()
      RETURNING quotation_line_id`, [versionId,lineId,w.coverage,w.coveredServices,w.coveredMaterials,w.conditions,w.exclusions,w.commencementRule,w.endRule,w.durationDays,w.fixedEndDate,replacesQuotationLineId,actorUserId]);
    if (!result.rowCount) throw AppError.notFound('Quotation line not found in the requested version.');
    return { quotationVersionId: versionId, quotationLineId: lineId, warrantyTerms: w, replacesQuotationLineId };
  });
}

/** Human-readable text; lifecycle expired_at is deliberately never consulted. */
export function appendWarrantyText(add: (label: string, value: unknown) => void, w?: WarrantyTerms | null) {
  if (!w) { add('Warranty', 'NOT DISCLOSED in historical offer - supplemental agreement required'); return; }
  add('Warranty coverage', w.coverage);
  if (w.coverage === 'NONE') { add('Warranty status', 'No warranty for this item'); return; }
  add('Covered services', w.coveredServices);
  add('Covered materials', w.coveredMaterials);
  add('Warranty conditions', w.conditions);
  add('Warranty exclusions', w.exclusions);
  add('Warranty commencement', 'BAST accepted at the recorded acceptance instant');
  add('Contractual end', w.endRule === 'DURATION_DAYS'
    ? `${w.durationDays} consecutive 24-hour days after acceptance`
    : `${w.fixedEndDate} inclusive, through end of day Asia/Jakarta`);
}
