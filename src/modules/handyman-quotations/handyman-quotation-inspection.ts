import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { handymanServiceRequestNotFoundError } from '../handyman-requests/handyman-request-triage.errors';

/** Catalog preparation is not the only quotation entry point. Enforce the
 * existing INSPECTION_FIRST posture at the original manual commands too.
 * FIXED/ESTIMATED retain the direct diagnosis lane; an unavailable visit or
 * NOT_INSPECTABLE record never stands in for a completed site inspection. */
export async function assertHandymanQuotationInspectionReady(tx: PoolClient, requestId: string): Promise<void> {
  const result = await tx.query<{ client_id: string; service_catalog_id: string; building_id: string | null }>(
    'SELECT client_id, service_catalog_id, building_id FROM handyman_service_requests WHERE id=$1 FOR UPDATE', [requestId]);
  const request = result.rows[0];
  if (!request) throw handymanServiceRequestNotFoundError();
  const profiles = await tx.query<{ pricing_mode: string }>(`
    SELECT p.pricing_mode FROM handyman_service_commercial_profiles p
    WHERE p.client_id=$2 AND (p.service_catalog_id=$3 OR EXISTS (
      SELECT 1 FROM handyman_service_request_items i
      WHERE i.handyman_request_id=$1 AND i.client_id=p.client_id
        AND i.service_catalog_id=p.service_catalog_id AND i.status='ACTIVE'))
    FOR SHARE OF p`, [requestId, request.client_id, request.service_catalog_id]);
  if (!profiles.rows.some(p => p.pricing_mode === 'INSPECTION_FIRST')) return;
  const inspected = await tx.query(`SELECT id FROM handyman_request_inspections
    WHERE handyman_request_id=$1 AND client_id=$2 AND building_id=$3 AND inspection_result='INSPECTED'`,
    [requestId, request.client_id, request.building_id]);
  if (inspected.rowCount !== 1) {
    throw AppError.validation('A completed inspection is required before quoting an INSPECTION_FIRST service.',
      [{ field: 'inspection', message: 'Record an INSPECTED result for this request; booking or NOT_INSPECTABLE is insufficient.' }]);
  }
}
