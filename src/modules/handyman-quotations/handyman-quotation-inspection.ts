import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { handymanServiceRequestNotFoundError } from '../handyman-requests/handyman-request-triage.errors';
import { hasReusableLinkedInspection } from './handyman-quotation-inspection-reuse';

/**
 * Catalog preparation is not the only quotation entry point. Enforce the
 * existing INSPECTION_FIRST posture at the original manual commands too.
 * FIXED/ESTIMATED retain the direct diagnosis lane; an unavailable visit or
 * NOT_INSPECTABLE record never stands in for a completed site inspection.
 *
 * CR-HM-MANUAL-QUOTATION-01 PART 03A: readiness can no longer be inferred from
 * a nullable `service_catalog_id` (or from the absence of a commercial profile,
 * which is what that absence silently used to mean). A manual-origin request
 * created from verified unlisted intake/triage (0488) has NO catalog anchor and
 * no Service Commercial Profile at all, so its readiness is decided from its
 * provenance instead: an inspection is ALWAYS mandated on that lane, and when
 * no authoritative exemption fact exists the gate fails closed — it never
 * bypasses. The catalog lane below is unchanged.
 */

type RequestLane = {
  client_id: string;
  service_catalog_id: string | null;
  building_id: string | null;
  intake_source: 'CATALOG' | 'UNLISTED_TRIAGE';
  unlisted_intake_case_id: string | null;
};

/** Exactly one authoritative INSPECTED record for this request, in the same
 * Client/Building scope. A missing, ambiguous or NOT_INSPECTABLE record never
 * stands in for a completed site inspection. */
async function assertInspectedSiteVisit(
  tx: PoolClient,
  request: RequestLane,
  requestId: string,
  message: string,
): Promise<void> {
  const inspected = await tx.query(`SELECT id FROM handyman_request_inspections
    WHERE handyman_request_id=$1 AND client_id=$2 AND building_id=$3 AND inspection_result='INSPECTED'`,
    [requestId, request.client_id, request.building_id]);
  if (inspected.rowCount === 1) return;
  // The reuse check also refuses an existing NOT_INSPECTABLE child record.
  if (request.intake_source === 'CATALOG' && await hasReusableLinkedInspection(tx, requestId)) return;
  throw AppError.validation(message, [
    {
      field: 'inspection',
      message:
        'An INSPECTED result for this request or a valid linked inspection covering the same scope is required; booking or NOT_INSPECTABLE is insufficient.',
    },
  ]);
}

/** Manual lane only: quote-readiness must rest on provenance the intake/triage
 * flow actually verified, never on a nullable catalog id. The request must
 * still be bound to its intake case, that case must be the triage state's
 * converted request, its effective decision must be the one-time manual
 * quotation, and the Client scope must match. Anything else fails closed. */
async function assertManualProvenance(
  tx: PoolClient,
  request: RequestLane,
  requestId: string,
): Promise<void> {
  const provenance = await tx.query(`
    SELECT 1 FROM handyman_unlisted_service_intake_cases c
      JOIN handyman_unlisted_intake_triage_state st
        ON st.intake_case_id = c.id AND st.converted_request_id = $1
      JOIN handyman_unlisted_intake_triage_decisions d
        ON d.id = st.triage_decision_id AND d.intake_case_id = c.id
     WHERE c.id = $2 AND c.client_id = $3 AND c.building_id = $4
       AND c.status = 'TRIAGED_MANUAL_QUOTATION_READY'
       AND d.decision = 'ONE_TIME_MANUAL_QUOTATION_REQUIRED'`,
    [
      requestId,
      request.unlisted_intake_case_id,
      request.client_id,
      request.building_id,
    ]);
  if (provenance.rowCount !== 1) {
    throw AppError.validation(
      'A manual-origin quotation needs verified unlisted-intake triage provenance.',
      [
        {
          field: 'intakeProvenance',
          message:
            'The request must remain bound to a TRIAGED_MANUAL_QUOTATION_READY intake case whose effective triage decision is ONE_TIME_MANUAL_QUOTATION_REQUIRED. Without that authoritative exemption the quotation is refused, not bypassed.',
        },
      ],
    );
  }
}

export async function assertHandymanQuotationInspectionReady(tx: PoolClient, requestId: string): Promise<void> {
  const result = await tx.query<RequestLane>(
    `SELECT client_id, service_catalog_id, building_id, intake_source,
            unlisted_intake_case_id
       FROM handyman_service_requests
      WHERE id=$1
      FOR UPDATE`,
    [requestId],
  );
  const request = result.rows[0];
  if (!request) throw handymanServiceRequestNotFoundError();
  if (request.intake_source === 'UNLISTED_TRIAGE') {
    await assertManualProvenance(tx, request, requestId);
    await assertInspectedSiteVisit(
      tx,
      request,
      requestId,
      'A completed inspection is required before quoting this manual-origin (unlisted-intake) service.',
    );
    return;
  }
  const profiles = await tx.query<{ pricing_mode: string }>(`
    SELECT p.pricing_mode FROM handyman_service_commercial_profiles p
    WHERE p.client_id=$2 AND (p.service_catalog_id=$3 OR EXISTS (
      SELECT 1 FROM handyman_service_request_items i
      WHERE i.handyman_request_id=$1 AND i.client_id=p.client_id
        AND i.service_catalog_id=p.service_catalog_id AND i.status='ACTIVE'))
    FOR SHARE OF p`, [requestId, request.client_id, request.service_catalog_id]);
  if (!profiles.rows.some(p => p.pricing_mode === 'INSPECTION_FIRST')) return;
  await assertInspectedSiteVisit(
    tx,
    request,
    requestId,
    'A completed inspection is required before quoting an INSPECTION_FIRST service.',
  );
}
