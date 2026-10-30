import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { assertVerifiedManagedEvidenceReference } from '../handyman-field-evidence/handyman-field-evidence.service';

/** There is no inspection-expiry field in the existing inspection/evidence
 * contracts. Do not invent a lifetime: reuse is disabled until an operator
 * explicitly configures an approved maximum age in whole seconds. */
function configuredMaxAgeSeconds(): number | null {
  const value = process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS?.trim();
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const seconds = Number(value);
  // Bound the interval to a PostgreSQL-safe signed integer, without a default.
  return Number.isSafeInteger(seconds) && seconds <= 2_147_483_647 ? seconds : null;
}

/**
 * Reuse is deliberately narrower than a same-request inspection. A link alone
 * is not authority: recheck the original authorized outcome, fee decision,
 * exact customer/location, technical scope and live evidence bytes at each
 * quotation create/issue/approve boundary. No inspection or consent is made.
 *
 * Structured request items and variant attributes are mutable and there is no
 * immutable technical-scope snapshot at inspection time. They therefore fail
 * closed rather than being inferred from current values or timestamps.
 * Manual/unlisted requests also lack comparable catalogue scope. Byte
 * verification does not certify a report's human content.
 */
export async function hasReusableLinkedInspection(tx: PoolClient, workRequestId: string): Promise<boolean> {
  const maxAge = configuredMaxAgeSeconds();
  if (maxAge === null) return false;

  // Quote writers already lock the child; take it here as well for other
  // callers. SKIP LOCKED on the parent avoids deadlock with a concurrent link
  // replay that locks both requests in deterministic order.
  const child = await tx.query('SELECT id FROM handyman_service_requests WHERE id=$1 FOR UPDATE', [workRequestId]);
  if (child.rowCount !== 1) return false;
  const link = (await tx.query<{ inspection_request_id: string }>(
    'SELECT inspection_request_id FROM handyman_inspection_work_links WHERE work_request_id=$1', [workRequestId],
  )).rows[0];
  if (!link) return false;
  const parent = await tx.query<{ service_variant_id: string | null }>(
    'SELECT service_variant_id FROM handyman_service_requests WHERE id=$1 FOR UPDATE SKIP LOCKED', [link.inspection_request_id]);
  if (parent.rowCount !== 1) {
    throw new AppError({ code: ERROR_CODES.CONFLICT, statusCode: 409,
      message: 'The linked inspection is being updated; retry the work quotation.' });
  }
  if (parent.rows[0].service_variant_id) {
    // Prevent new mutable variant attributes being attached during the check.
    const variant = await tx.query('SELECT id FROM handyman_service_variants WHERE id=$1 FOR UPDATE SKIP LOCKED',
      [parent.rows[0].service_variant_id]);
    if (variant.rowCount !== 1) throw new AppError({ code: ERROR_CODES.CONFLICT, statusCode: 409,
      message: 'The inspection service variant is being updated; retry the work quotation.' });
  }
  // Parent locks also fence new FK-bound item inserts; row locks fence edits.
  await tx.query(`SELECT id FROM handyman_service_request_items
    WHERE handyman_request_id IN ($1,$2) ORDER BY id FOR SHARE`, [link.inspection_request_id, workRequestId]);

  const source = (await tx.query<{
    client_id: string; building_id: string; inspection_request_id: string;
    evidence_upload_id: string; evidence_sha256: string; evidence_byte_size: number;
  }>(`
    SELECT l.client_id,l.building_id,l.inspection_request_id,l.evidence_upload_id,
           l.evidence_sha256,l.evidence_byte_size
      FROM handyman_inspection_work_links l
      JOIN handyman_service_requests p ON p.id=l.inspection_request_id
        AND p.client_id=l.client_id AND p.building_id=l.building_id
        AND p.tenant_company_id=l.tenant_company_id AND p.space_id IS NOT DISTINCT FROM l.space_id
      JOIN handyman_service_requests w ON w.id=l.work_request_id
        AND w.client_id=p.client_id AND w.building_id=p.building_id
        AND w.tenant_company_id=p.tenant_company_id AND w.space_id IS NOT DISTINCT FROM p.space_id
        AND w.intake_source='CATALOG' AND p.intake_source='CATALOG'
        AND w.service_catalog_id=p.service_catalog_id
        AND w.service_variant_id IS NOT DISTINCT FROM p.service_variant_id
        AND w.description IS NOT DISTINCT FROM p.description
      JOIN handyman_request_inspections i ON i.id=l.inspection_id AND i.handyman_request_id=p.id
        AND i.client_id=p.client_id AND i.building_id=p.building_id
        AND i.channel_attribution_id=p.channel_attribution_id AND i.inspection_result='INSPECTED'
      JOIN handyman_field_evidence_uploads e ON e.id=l.evidence_upload_id
        AND e.client_id=p.client_id AND e.building_id=p.building_id
        AND e.tenant_company_id=p.tenant_company_id AND e.handyman_request_id=p.id
        AND e.execution_scope_id IS NULL AND e.purpose='INSPECTION_EVIDENCE'
        AND e.upload_status='VERIFIED' AND e.verified_at IS NOT NULL
        AND e.attachment_reference=('hm-ev://' || e.id::text)
        AND e.sha256_checksum=l.evidence_sha256 AND e.verified_byte_size=l.evidence_byte_size
      JOIN handyman_inspection_fee_terms ft ON ft.handyman_request_id=p.id
        AND ft.treatment='PAID_SEPARATE' AND ft.agreed_amount>0
        AND ft.fee_execution_scope_id=l.fee_execution_scope_id
      JOIN handyman_execution_scopes s ON s.id=ft.fee_execution_scope_id
        AND s.client_id=p.client_id AND s.building_id=p.building_id
        AND s.tenant_company_id=p.tenant_company_id AND s.space_id IS NOT DISTINCT FROM p.space_id
        AND s.handyman_request_id<>p.id AND s.handyman_request_id<>w.id AND s.status='AUTHORIZED'
      JOIN handyman_quotation_versions v ON v.id=s.approved_quotation_version_id
        AND v.quotation_id=s.quotation_id AND v.status='APPROVED'
      JOIN handyman_quotation_decisions d ON d.id=s.quotation_decision_id
        AND d.quotation_id=s.quotation_id AND d.quotation_version_id=v.id
        AND d.client_id=p.client_id AND d.tenant_company_id=p.tenant_company_id AND d.decision='APPROVE'
      JOIN handyman_inspection_fee_offers o ON o.quotation_version_id=v.id
        AND o.handyman_request_id=p.id AND o.treatment=ft.treatment
        AND o.no_proceed_treatment=ft.no_proceed_treatment
     WHERE l.work_request_id=$1
       AND NOT EXISTS (SELECT 1 FROM handyman_request_inspections wi WHERE wi.handyman_request_id=w.id)
       AND i.inspected_at <= statement_timestamp()
       AND i.inspected_at > statement_timestamp() - ($2::integer * interval '1 second')
       AND i.inspected_at <= l.created_at AND e.verified_at <= l.created_at
       AND ft.created_at <= i.inspected_at AND d.decided_at <= ft.created_at
       AND v.valid_until IS NOT NULL AND d.decided_at < v.valid_until
       AND EXISTS (SELECT 1 FROM operational_events ev
         WHERE ev.event_type='HANDYMAN_INSPECTION_RECORDED' AND ev.entity_type='HANDYMAN_SERVICE_REQUEST'
           AND ev.entity_id=p.id AND ev.client_id=p.client_id AND ev.building_id=p.building_id
           AND ev.actor_user_id=i.inspected_by_user_id AND ev.metadata->>'inspectionId'=i.id::text
           AND ev.metadata->>'inspectionResult'='INSPECTED')
       AND (p.service_variant_id IS NULL OR EXISTS (SELECT 1 FROM handyman_service_variants sv
         WHERE sv.id=p.service_variant_id AND sv.client_id=p.client_id AND sv.service_catalog_id=p.service_catalog_id))
       AND NOT EXISTS (SELECT 1 FROM handyman_service_variant_attributes va WHERE va.service_variant_id=p.service_variant_id)
       AND NOT EXISTS (SELECT 1 FROM handyman_service_request_items pi WHERE pi.handyman_request_id=p.id)
       AND NOT EXISTS (SELECT 1 FROM handyman_service_request_items wi WHERE wi.handyman_request_id=w.id AND wi.status='ACTIVE')`,
    [workRequestId, maxAge])).rows[0];
  if (!source) return false;

  try {
    const evidence = await assertVerifiedManagedEvidenceReference(tx, {
      clientId: source.client_id, buildingId: source.building_id,
      handymanRequestId: source.inspection_request_id, executionScopeId: null,
    }, `hm-ev://${source.evidence_upload_id}`, { requiredPurpose: 'INSPECTION_EVIDENCE' });
    return !!evidence && evidence.id === source.evidence_upload_id &&
      evidence.sha256Checksum === source.evidence_sha256 && evidence.verifiedByteSize === source.evidence_byte_size;
  } catch (error) {
    if (error instanceof AppError && [
      ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_NOT_FOUND,
      ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
      ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
      ERROR_CODES.HANDYMAN_EVIDENCE_REFERENCE_UNVERIFIED,
      ERROR_CODES.HANDYMAN_MATERIAL_RECEIPT_PURPOSE_INVALID,
    ].some(code => code === error.code)) return false;
    throw error;
  }
}
