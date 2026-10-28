import { getPool } from '../../database';
import type { CareWorkspacePrincipal } from './care-workspace.service';
import { WORKSPACE_OCCUPANCY_CTES } from './care-workspace-occupancies.repository';

export type CareOperationalSelection = {
  propertyId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
};

/**
 * One-statement, selected-request Care projection over existing Handyman
 * authorities. Every child query binds to the matched request/client/scope;
 * all collections are independently capped before JSON aggregation. It is a
 * SELECT-only composition and contains no lifecycle commands or caller money.
 */
async function readOperationalProjection(
  principal: CareWorkspacePrincipal,
  requestId: string,
  selection: CareOperationalSelection,
) {
  const result = await getPool().query<{
    authenticated: boolean;
    evaluatedAt: Date;
    data: Record<string, unknown> | null;
  }>(`
    ${WORKSPACE_OCCUPANCY_CTES}, selected AS (
      SELECT r.id AS "requestId", r.client_id AS "clientId",
             r.tenant_company_id AS "tenantCompanyId",
             r.building_id AS "buildingId", r.space_id AS "spaceId",
             r.status AS "requestStatus", r.created_at AS "createdAt",
             r.updated_at AS "updatedAt",
             es.id AS "executionScopeId"
        FROM handyman_service_requests r
        LEFT JOIN handyman_execution_scopes es
          ON es.handyman_request_id = r.id AND es.client_id = r.client_id AND es.scope_kind = 'ORIGINAL'
       WHERE $5::text IS NULL AND $6::integer = 1
         AND r.id = $10
         AND r.tenant_company_id = $7
         AND r.building_id = $8
         AND r.space_id IS NOT DISTINCT FROM $9::uuid
         AND EXISTS (
           SELECT 1 FROM records c
            WHERE c."clientId" = r.client_id
              AND c."tenantCompanyId" = r.tenant_company_id
              AND c."buildingId" = r.building_id
              AND c."spaceId" IS NOT DISTINCT FROM r.space_id
         )
       LIMIT 1
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      statement_timestamp() AS "evaluatedAt",
      (SELECT jsonb_build_object(
        'readOnly', TRUE,
        'request', jsonb_build_object(
          'id', s."requestId", 'clientId', s."clientId",
          'tenantCompanyId', s."tenantCompanyId", 'buildingId', s."buildingId",
          'spaceId', s."spaceId", 'status', s."requestStatus",
          'executionScopeId', s."executionScopeId",
          'createdAt', s."createdAt", 'updatedAt', s."updatedAt",
          'items', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', ri.id, 'serviceCatalogId', ri.service_catalog_id,
              'serviceCode', sc.code, 'serviceName', sc.name,
              'serviceVariantId', ri.service_variant_id,
              'variantCode', sv.code, 'variantName', sv.name,
              'quantity', ri.quantity::text, 'uomId', ri.uom_id,
              'uomCode', u.code, 'uomName', u.name, 'uomSymbol', u.symbol,
              'attributeValues', ri.attribute_values,
              'inheritedAttributeValues', ri.inherited_attribute_values,
              'itemDescription', ri.item_description,
              'accessCondition', ri.access_condition, 'status', ri.status,
              'createdAt', ri.created_at, 'updatedAt', ri.updated_at)
              ORDER BY ri.created_at, ri.id)
              FROM (SELECT * FROM handyman_service_request_items
                     WHERE handyman_request_id = s."requestId"
                       AND client_id = s."clientId" AND status = 'ACTIVE'
                     ORDER BY created_at, id LIMIT 50) ri
              JOIN service_catalog sc ON sc.id = ri.service_catalog_id
                AND sc.client_id = ri.client_id
              LEFT JOIN handyman_service_variants sv ON sv.id = ri.service_variant_id
                AND sv.client_id = ri.client_id
              LEFT JOIN units_of_measure u ON u.id = ri.uom_id
                AND u.client_id = ri.client_id
          ), '[]'::jsonb)),
        'documentAvailability', jsonb_build_object(
          'quotation', CASE WHEN EXISTS (SELECT 1 FROM handyman_quotations q WHERE q.handyman_request_id = s."requestId" AND q.client_id = s."clientId") THEN 'PRESENT' ELSE 'NOT_CREATED' END,
          'bast', CASE WHEN EXISTS (SELECT 1 FROM handyman_bast_documents b WHERE b.execution_scope_id = s."executionScopeId" AND b.client_id = s."clientId") THEN 'PRESENT' ELSE 'NOT_CREATED' END,
          'warranty', CASE WHEN EXISTS (SELECT 1 FROM handyman_service_warranties w WHERE w.execution_scope_id = s."executionScopeId" AND w.client_id = s."clientId") THEN 'PRESENT' ELSE 'NOT_ACTIVATED' END),
        'inspection', (
          SELECT jsonb_build_object(
            'id', x.id, 'result', x.inspection_result,
            'notes', x.inspection_notes, 'inspectedAt', x.inspected_at)
            FROM handyman_request_inspections x
           WHERE x.handyman_request_id = s."requestId"
             AND x.client_id = s."clientId"
           LIMIT 1),
        'inspectionWorkLink', (
          SELECT jsonb_build_object('inspectionRequestId', l.inspection_request_id,
            'workRequestId', l.work_request_id, 'inspectionId', l.inspection_id,
            'inspectionEvidenceId', l.evidence_upload_id, 'feeRequestId', fs.handyman_request_id,
            'feeExecutionScopeId', l.fee_execution_scope_id)
          FROM handyman_inspection_work_links l
          JOIN handyman_execution_scopes fs ON fs.id=l.fee_execution_scope_id
          WHERE (l.inspection_request_id=s."requestId" OR l.work_request_id=s."requestId")
            AND l.client_id=s."clientId" AND l.building_id=s."buildingId"
            AND l.tenant_company_id=s."tenantCompanyId" AND l.space_id IS NOT DISTINCT FROM s."spaceId"
          LIMIT 1),
        'financialTerms', jsonb_build_object(
          'unconfiguredTaxIsExempt', FALSE,
          'inspectionAgreement', (
            SELECT jsonb_build_object('treatment', ft.treatment,
              'feeExecutionScopeId', ft.fee_execution_scope_id,
              'agreedAmount', ft.agreed_amount::numeric(18,2)::text,
              'currency', ft.currency, 'noProceedTreatment', ft.no_proceed_treatment)
            FROM handyman_inspection_fee_terms ft WHERE ft.handyman_request_id=s."requestId"),
          'inspectionOffers', COALESCE((
            SELECT jsonb_agg(o.item) FROM (
              SELECT jsonb_build_object('quotationVersionId', f.quotation_version_id,
                'treatment', f.treatment, 'noProceedTreatment', f.no_proceed_treatment,
                'creditMode', f.credit_mode, 'status', v.status,
                'gross', (SELECT SUM(l.line_total)::numeric(18,2)::text FROM handyman_quotation_lines l WHERE l.quotation_version_id=v.id)) item
              FROM handyman_inspection_fee_offers f JOIN handyman_quotation_versions v ON v.id=f.quotation_version_id
              WHERE f.handyman_request_id=s."requestId" AND v.status<>'DRAFT'
              ORDER BY f.created_at DESC LIMIT 20
            ) o), '[]'::jsonb),
          'quotationTaxes', COALESCE((
            SELECT jsonb_agg(t.item) FROM (
              SELECT jsonb_build_object('quotationVersionId', v.id, 'priceBasis', p.facts->>'priceBasis',
                'providerStatus', p.facts->>'providerStatus', 'vatRegime', p.facts->>'vatRegime',
                'incomeTax', p.facts->>'incomeTax', 'payerIsWithholder', p.facts->'payerIsWithholder') item
              FROM handyman_financial_tax_profiles p JOIN handyman_quotation_versions v ON v.id=p.quotation_version_id
              JOIN handyman_quotations q ON q.id=v.quotation_id
              WHERE q.handyman_request_id=s."requestId" AND q.client_id=s."clientId" AND v.status<>'DRAFT'
              ORDER BY v.version_number DESC LIMIT 20
            ) t), '[]'::jsonb)),
        'quotation', (
          SELECT jsonb_build_object(
            'id', q.id, 'createdAt', q.created_at, 'createdByUserId', q.created_by_user_id,
            'serviceRequestId', s."requestId", 'tenantCompanyId', s."tenantCompanyId",
            'buildingId', s."buildingId", 'spaceId', s."spaceId",
            'executionScopeId', s."executionScopeId",
            'versions', COALESCE((
              SELECT jsonb_agg(v.item ORDER BY v.version_number DESC)
                FROM (
                  SELECT v.version_number,
                    jsonb_build_object(
                      'id', v.id, 'versionNumber', v.version_number,
                      'status', v.status, 'validUntil', v.valid_until,
                      'officialDocument', CASE WHEN doc.id IS NULL THEN NULL ELSE jsonb_build_object(
                        'number', doc.document_number, 'issuedAt', doc.issued_at,
                        'downloadPath', '/api/v1/handyman/care/requests/' || s."requestId"::text ||
                          '/quotation-versions/' || v.id::text || '/document.pdf') END,
                      'createdAt', v.created_at, 'createdByUserId', v.created_by_user_id,
                      'decision', d.decision, 'decisionId', d.id,
                      'decidedAt', d.decided_at, 'decidedByUserId', d.decided_by_user_id,
                      'decisionTenantCompanyId', d.tenant_company_id,
                      'decisionTenantPicId', d.tenant_pic_id,
                      'dpRequired', v.dp_required, 'dpPercentage', v.dp_percentage,
                      'dpAmount', v.dp_amount::numeric(18,2)::text,
                      'dpTermsNotes', v.dp_terms_notes,
                      'lineTotalSum', (SELECT SUM(ql.line_total)::numeric(18,2)::text
                        FROM handyman_quotation_lines ql WHERE ql.quotation_version_id = v.id),
                      'currency', (SELECT CASE WHEN COUNT(DISTINCT ql.currency) = 1 THEN MIN(ql.currency) END
                        FROM handyman_quotation_lines ql WHERE ql.quotation_version_id = v.id),
                      'lines', COALESCE((
                        SELECT jsonb_agg(l.item ORDER BY l.created_at, l.id)
                          FROM (
                            SELECT ql.id, ql.created_at,
                              jsonb_build_object(
                                'id', ql.id, 'lineType', ql.line_type,
                                'description', ql.description,
                                'quantity', ql.quantity::text, 'uomId', ql.uom_id,
                                'unitAmount', ql.final_quoted_unit_amount::numeric(18,2)::text,
                                'lineTotal', ql.line_total::numeric(18,2)::text,
                                'currency', ql.currency) AS item
                              FROM handyman_quotation_lines ql
                             WHERE ql.quotation_version_id = v.id
                             ORDER BY ql.created_at, ql.id LIMIT 100
                          ) l), '[]'::jsonb)) AS item
                    FROM handyman_quotation_versions v
                    LEFT JOIN handyman_quotation_decisions d
                      ON d.quotation_version_id = v.id
                    LEFT JOIN handyman_quotation_documents doc
                      ON doc.quotation_version_id = v.id AND doc.quotation_id=q.id AND doc.client_id=q.client_id
                   WHERE v.quotation_id = q.id
                   ORDER BY v.version_number DESC LIMIT 20
                ) v), '[]'::jsonb))
            FROM handyman_quotations q
           WHERE q.handyman_request_id = s."requestId"
             AND q.client_id = s."clientId"
           LIMIT 1),
        'variationOffers', COALESCE((
          SELECT jsonb_agg(x.item ORDER BY x.issued_at DESC, x.id DESC) FROM (
            SELECT d.id,d.issued_at,jsonb_build_object(
              'variationId', v.id, 'variationStatus', v.status, 'tenantDecision', v.tenant_decision_outcome,
              'offerStatus', 'ISSUED', 'documentId', d.id, 'documentVersion', d.variation_version,
              'number', d.document_number, 'issuedAt', d.issued_at, 'pdfSha256', d.pdf_sha256,
              'revisedQuotationVersionId', d.revised_quotation_version_id,
              'downloadPath', '/api/v1/handyman/care/requests/' || s."requestId"::text ||
                '/variations/' || v.id::text || '/offer.pdf') AS item
            FROM handyman_variation_offer_documents d
            JOIN handyman_scope_variations v ON v.id=d.variation_id AND v.execution_scope_id=d.execution_scope_id
            WHERE d.client_id=s."clientId" AND d.request_id=s."requestId" AND d.execution_scope_id=s."executionScopeId"
            ORDER BY d.issued_at DESC,d.id DESC LIMIT 50
          ) x), '[]'::jsonb),
        'scheduling', jsonb_build_object(
          'readiness', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', sr.id, 'status', sr.status, 'timezone', sr.timezone,
              'preferredWindowStart', sr.preferred_window_start,
              'preferredWindowEnd', sr.preferred_window_end,
              'supersedesReadinessId', sr.supersedes_readiness_id,
              'changeReason', sr.change_reason, 'createdAt', sr.created_at,
              'updatedAt', sr.updated_at)
              ORDER BY sr.created_at DESC, sr.id DESC)
              FROM (SELECT * FROM handyman_scheduling_readiness
                     WHERE handyman_request_id = s."requestId"
                       AND client_id = s."clientId"
                     ORDER BY created_at DESC, id DESC LIMIT 50) sr
          ), '[]'::jsonb),
          'appointments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', a.id, 'kind', a.kind, 'startAt', a.start_at,
              'endAt', a.end_at, 'timezone', a.timezone, 'state', a.state,
              'version', a.version, 'confirmedAt', a.confirmed_at,
              'cancelledAt', a.cancelled_at, 'createdAt', a.created_at,
              'updatedAt', a.updated_at)
              ORDER BY a.created_at DESC, a.id DESC)
              FROM (SELECT * FROM handyman_visit_appointments
                     WHERE handyman_request_id = s."requestId"
                       AND client_id = s."clientId"
                       AND tenant_company_id = s."tenantCompanyId"
                       AND building_id = s."buildingId"
                       AND (execution_scope_id IS NULL
                         OR execution_scope_id = s."executionScopeId")
                     ORDER BY created_at DESC, id DESC LIMIT 50) a
          ), '[]'::jsonb)),
        'quality', jsonb_build_object(
          'evidence', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', e.id, 'stage', e.stage, 'description', e.description,
              'createdAt', e.created_at, 'files', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', f.id, 'mediaKind', f.media_kind,
                  'contentType', f.content_type, 'byteSize', f.byte_size,
                  'sha256Digest', f.sha256_digest, 'captureTime', f.capture_time,
                  'createdAt', f.created_at)
                  ORDER BY f.created_at, f.id)
                  FROM (SELECT * FROM handyman_evidence_record_files
                         WHERE record_id = e.id
                         ORDER BY created_at, id LIMIT 25) f), '[]'::jsonb))
              ORDER BY e.created_at DESC, e.id DESC)
              FROM (SELECT * FROM handyman_evidence_records
                     WHERE execution_scope_id = s."executionScopeId"
                       AND client_id = s."clientId"
                     ORDER BY created_at DESC, id DESC LIMIT 50) e
          ), '[]'::jsonb),
          'qcRuns', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', qr.id, 'status', qr.status,
              'checklistIdentity', qr.checklist_identity,
              'createdAt', qr.created_at, 'updatedAt', qr.updated_at,
              'items', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', qi.id, 'itemKey', qi.item_key,
                  'outcome', qi.outcome, 'note', qi.note,
                  'createdAt', qi.created_at, 'updatedAt', qi.updated_at)
                  ORDER BY qi.created_at, qi.id)
                  FROM (SELECT * FROM handyman_qc_run_items
                         WHERE run_id = qr.id
                         ORDER BY created_at, id LIMIT 100) qi), '[]'::jsonb))
              ORDER BY qr.created_at DESC, qr.id DESC)
              FROM (SELECT * FROM handyman_qc_runs
                     WHERE execution_scope_id = s."executionScopeId"
                       AND client_id = s."clientId"
                     ORDER BY created_at DESC, id DESC LIMIT 50) qr
          ), '[]'::jsonb),
          'defects', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', d.id, 'status', d.status, 'description', d.description,
              'createdAt', d.created_at, 'updatedAt', d.updated_at)
              ORDER BY d.created_at DESC, d.id DESC)
              FROM (SELECT * FROM handyman_defect_records
                     WHERE execution_scope_id = s."executionScopeId"
                       AND client_id = s."clientId"
                     ORDER BY created_at DESC, id DESC LIMIT 50) d
          ), '[]'::jsonb)),
        'bast', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', b.id, 'serviceRequestId', s."requestId",
            'executionScopeId', b.execution_scope_id,
            'status', b.status, 'issuedAt', b.issued_at,
            'officialDocument', (SELECT jsonb_build_object(
              'id', d.id, 'number', d.document_number, 'issuedAt', d.issued_at,
              'pdfSha256', d.pdf_sha256,
              'downloadPath', '/api/v1/handyman/care/requests/' || s."requestId"::text ||
                '/basts/' || b.id::text || '/document.pdf')
              FROM handyman_bast_official_documents d WHERE d.bast_id=b.id
                AND d.execution_scope_id=b.execution_scope_id AND d.client_id=s."clientId"
                AND d.request_id=s."requestId" AND d.building_id=s."buildingId"
                AND d.tenant_company_id=s."tenantCompanyId"),
            'issuerUserId', (SELECT be.actor_user_id FROM handyman_bast_events be
              WHERE be.bast_id = b.id AND be.event_type = 'ISSUE'
              ORDER BY be.occurred_at DESC, be.id DESC LIMIT 1),
            'qcRunId', b.qc_run_id,
            'workSessions', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', ws.id, 'status', ws.status, 'checkedInAt', ws.checked_in_at,
                'startedWorkAt', ws.started_work_at, 'completedAt', ws.completed_at,
                'checkedOutAt', ws.checked_out_at, 'leadWorkerId', ws.lead_worker_id)
                ORDER BY ws.created_at, ws.id)
                FROM (SELECT * FROM handyman_work_sessions
                       WHERE execution_scope_id = b.execution_scope_id
                         AND client_id = s."clientId"
                       ORDER BY created_at, id LIMIT 50) ws), '[]'::jsonb),
            'materialUsage', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', ml.id, 'quotationLineId', ml.quotation_line_id,
                'sourceItemId', ml.source_item_id, 'itemCode', ii.code,
                'itemName', ii.name, 'uomId', ql.uom_id, 'uomCode', u.code,
                'status', ml.status, 'estimatedQuantity', ml.estimated_qty::text,
                'approvedQuantity', ml.approved_qty::text,
                'issuedQuantity', ml.issued_qty::text,
                'purchasedQuantity', ml.purchased_qty::text,
                'usedQuantity', ml.used_qty::text,
                'returnedQuantity', ml.returned_qty::text)
                ORDER BY ml.created_at, ml.id)
                FROM (SELECT * FROM handyman_material_execution_lines
                       WHERE execution_scope_id = b.execution_scope_id
                         AND client_id = s."clientId"
                       ORDER BY created_at, id LIMIT 100) ml
                JOIN handyman_quotation_lines ql ON ql.id = ml.quotation_line_id
                LEFT JOIN inventory_items ii ON ii.id = ml.source_item_id
                LEFT JOIN units_of_measure u ON u.id = ql.uom_id), '[]'::jsonb),
            'acceptedAt', b.accepted_at, 'rejectedAt', b.rejected_at,
            'voidedAt', b.voided_at, 'createdAt', b.created_at,
            'events', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'eventType', be.event_type, 'occurredAt', be.occurred_at)
                ORDER BY be.occurred_at, be.id)
                FROM (SELECT * FROM handyman_bast_events
                       WHERE bast_id = b.id AND client_id = s."clientId"
                       ORDER BY occurred_at, id LIMIT 50) be), '[]'::jsonb),
            'signOffs', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'decision', so.decision, 'rejectReason', so.reject_reason,
                'eventId', so.event_id, 'signerUserId', be.actor_user_id,
                'createdAt', so.created_at)
                ORDER BY so.created_at, so.id)
                FROM (SELECT * FROM handyman_bast_sign_offs
                       WHERE bast_id = b.id AND client_id = s."clientId"
                       ORDER BY created_at, id LIMIT 10) so
                JOIN handyman_bast_events be ON be.id = so.event_id
                  AND be.client_id = so.client_id), '[]'::jsonb))
            ORDER BY b.created_at DESC, b.id DESC)
            FROM (SELECT * FROM handyman_bast_documents
                   WHERE execution_scope_id = s."executionScopeId"
                     AND client_id = s."clientId"
                   ORDER BY created_at DESC, id DESC LIMIT 10) b
        ), '[]'::jsonb),
        'invoicePayment', jsonb_build_object(
          'officialInvoice', (
            SELECT jsonb_build_object('id', i.id, 'invoiceNumber', i.document_number,
              'status', 'ISSUED', 'issuedAt', i.issued_at, 'totalAmount', i.total_amount::numeric(18,2)::text,
              'currencyCode', i.currency, 'pdfSha256', i.pdf_sha256, 'sourceSha256', i.source_sha256)
              FROM handyman_official_invoices i
             WHERE i.execution_scope_id=s."executionScopeId" AND i.client_id=s."clientId"
               AND i.request_id=s."requestId" AND i.building_id=s."buildingId" AND i.tenant_company_id=s."tenantCompanyId"
             LIMIT 1),
          'invoice', (
            SELECT jsonb_build_object(
              'id', i.id, 'invoiceNumber', i.invoice_number,
              'invoiceDate', i.invoice_date, 'dueDate', i.due_date,
              'status', i.status,
              'totalAmount', i.total_amount::numeric(18,2)::text,
              'currencyCode', i.currency_code,
              'createdAt', i.created_at, 'updatedAt', i.updated_at,
              'lines', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', il.id, 'sourceType', il.source_type,
                  'handymanChargeLineId', il.handyman_charge_line_id,
                  'amount', il.amount_snapshot::numeric(18,2)::text,
                  'currencyCode', il.currency_code,
                  'createdAt', il.created_at)
                  ORDER BY il.created_at, il.id)
                  FROM (SELECT * FROM tenant_invoice_lines
                         WHERE invoice_id = i.id
                         ORDER BY created_at, id LIMIT 100) il), '[]'::jsonb))
              FROM tenant_invoices i
             WHERE i.handyman_execution_scope_id = s."executionScopeId"
               AND i.client_id = s."clientId"
             LIMIT 1),
          'paymentStatus', COALESCE((
            SELECT jsonb_build_object(
              'status', v.status, 'invoiceTotal', v.invoice_total::text,
              'appliedAmount', v.applied_amount::text, 'outstandingAmount', v.outstanding_amount::text,
              'verifiedReceivedAmount', v.verified_received_amount::text,
              'unallocatedVerifiedAmount', v.unallocated_verified_amount::text,
              'excessFundsAmount', v.excess_funds_amount::text,
              'unlinkedAllocationAmount', v.unlinked_allocation_amount::text,
              'unlinkedVerifiedAmount', v.unlinked_verified_amount::text,
              'unlinkedVerifiedCount', v.unlinked_verified_count,
              'currencyCode', v.currency, 'evaluatedAt', statement_timestamp())
            FROM handyman_official_invoice_payment_status v JOIN handyman_official_invoices oi ON oi.id=v.invoice_id
            WHERE oi.execution_scope_id=s."executionScopeId" AND v.client_id=s."clientId"
              AND v.building_id=s."buildingId" AND v.tenant_company_id=s."tenantCompanyId"
              AND oi.request_id=s."requestId" LIMIT 1
          ), (
            SELECT jsonb_build_object(
              'status', CASE
                WHEN i.status = 'CANCELLED' THEN 'CANCELLED'
                WHEN i.status <> 'FINALIZED' THEN 'NOT_DERIVED'
                WHEN GREATEST(i.total_amount - COALESCE(a.applied, 0), 0) = 0 THEN 'PAID'
                WHEN i.due_date < (statement_timestamp() AT TIME ZONE 'UTC')::date THEN 'OVERDUE'
                WHEN COALESCE(a.applied, 0) > 0 THEN 'PARTIALLY_PAID'
                ELSE 'UNPAID' END,
              'invoiceTotal', i.total_amount::numeric(18,2)::text,
              'allocatedAmount', COALESCE(a.allocated, 0)::numeric(18,2)::text,
              'reversedAllocationAmount', COALESCE(a.reversed, 0)::numeric(18,2)::text,
              'appliedAmount', COALESCE(a.applied, 0)::numeric(18,2)::text,
              'outstandingAmount', GREATEST(i.total_amount - COALESCE(a.applied, 0), 0)::numeric(18,2)::text,
              'currencyCode', i.currency_code,
              'evaluatedAt', statement_timestamp())
              FROM tenant_invoices i
              LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(a.amount), 0) AS allocated,
                       COALESCE(SUM(a.amount) FILTER (WHERE rev.source_allocation_id IS NOT NULL), 0) AS reversed,
                       COALESCE(SUM(a.amount) FILTER (WHERE rev.source_allocation_id IS NULL), 0) AS applied
                  FROM tenant_invoice_lines il
                  JOIN handyman_payment_allocations a
                    ON a.charge_line_id = il.handyman_charge_line_id
                  JOIN handyman_customer_payments p
                    ON p.id = a.payment_id AND p.status = 'CONFIRMED'
                  LEFT JOIN handyman_ledger_corrections rev
                    ON rev.correction_kind = 'REVERSAL'
                   AND rev.source_allocation_id = a.id
                 WHERE il.invoice_id = i.id
                   AND il.source_type = 'HANDYMAN_CHARGE'
              ) a ON TRUE
             WHERE i.handyman_execution_scope_id = s."executionScopeId"
               AND i.client_id = s."clientId"
             LIMIT 1)),
          'payments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', p.id, 'status', p.status,
              'verificationStatus', CASE WHEN p.status='PENDING' THEN 'PENDING_VERIFICATION' ELSE p.status END,
              'invoiceId', (SELECT l.invoice_id FROM handyman_official_invoice_payment_links l WHERE l.payment_id=p.id),
              'obligationStage', p.obligation_stage, 'externalReference', p.external_reference,
              'amount', p.amount::numeric(18,2)::text,
              'currency', p.currency, 'channel', p.channel, 'receivedAt', p.received_at,
              'allocatedToInvoice', COALESCE(a.applied, 0)::numeric(18,2)::text,
              'proofs', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', e.id, 'evidenceType', e.evidence_type,
                  'originalFileName', e.original_file_name, 'mimeType', e.mime_type,
                  'fileSize', e.file_size, 'contentSha256', e.content_sha256,
                  'status', e.status, 'createdAt', e.created_at)
                  ORDER BY e.created_at, e.id)
                  FROM (SELECT * FROM evidence_submissions
                         WHERE execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
                           AND execution_id = p.id AND status = 'ACTIVE'
                           AND content_sha256 IS NOT NULL
                         ORDER BY created_at, id LIMIT 1) e), '[]'::jsonb))
              ORDER BY p.received_at DESC, p.id DESC)
              FROM (SELECT * FROM handyman_customer_payments
                     WHERE transaction_id = (
                       SELECT tx.id FROM handyman_customer_transactions tx
                        WHERE tx.execution_scope_id = s."executionScopeId"
                          AND tx.client_id = s."clientId")
                       AND client_id = s."clientId"
                     ORDER BY received_at DESC, id DESC LIMIT 50) p
              LEFT JOIN LATERAL (
                SELECT GREATEST(COALESCE(SUM(a.amount) FILTER (WHERE rev.source_allocation_id IS NULL
                         AND p.status='CONFIRMED'), 0) - CASE WHEN EXISTS
                       (SELECT 1 FROM handyman_official_invoice_payment_links l WHERE l.payment_id=p.id)
                     THEN COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
                       WHERE c.correction_kind='REFUND' AND c.source_payment_id=p.id),0) ELSE 0 END, 0) AS applied
                  FROM handyman_payment_allocations a
                  LEFT JOIN handyman_ledger_corrections rev
                    ON rev.correction_kind = 'REVERSAL'
                   AND rev.source_allocation_id = a.id
                 WHERE a.payment_id = p.id
                   AND (a.charge_line_id IN (
                     SELECT il.handyman_charge_line_id FROM tenant_invoice_lines il
                      JOIN tenant_invoices i ON i.id = il.invoice_id
                     WHERE i.handyman_execution_scope_id = s."executionScopeId"
                       AND i.client_id = s."clientId"
                       AND il.source_type = 'HANDYMAN_CHARGE') OR EXISTS (
                     SELECT 1 FROM handyman_official_invoice_payment_links l
                       JOIN handyman_official_invoices i ON i.id=l.invoice_id
                       CROSS JOIN LATERAL jsonb_array_elements(i.source_snapshot#>'{calculation,commercialSource,lines}') x
                     WHERE l.payment_id=p.id AND i.execution_scope_id=s."executionScopeId"
                       AND i.client_id=s."clientId" AND x->>'chargeLineId'=a.charge_line_id::text))
              ) a ON TRUE
          ), '[]'::jsonb)),
        'warranty', (
          SELECT jsonb_build_object(
            'id', w.id, 'status', w.status, 'startsAt', w.starts_at,
            'expiredAt', w.expired_at, 'bastId', w.bast_id,
            'serviceRequestId', s."requestId", 'executionScopeId', s."executionScopeId",
            'bastAcceptedAt', w.bast_accepted_at,
            'coveredRequestItems', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'requestItemId', ri.id, 'serviceCatalogId', ri.service_catalog_id,
                'serviceVariantId', ri.service_variant_id, 'quantity', ri.quantity::text,
                'uomId', ri.uom_id, 'attributeValues', ri.attribute_values)
                ORDER BY ri.created_at, ri.id)
                FROM (SELECT * FROM handyman_service_request_items
                       WHERE handyman_request_id = s."requestId"
                         AND client_id = s."clientId" AND status = 'ACTIVE'
                       ORDER BY created_at, id LIMIT 50) ri
            ), '[]'::jsonb),
            'coverages', COALESCE((
              SELECT jsonb_agg(jsonb_build_object('type', c.coverage_type)
                ORDER BY c.coverage_type)
                FROM (SELECT * FROM handyman_service_warranty_coverages
                       WHERE warranty_id = w.id AND client_id = s."clientId"
                       ORDER BY coverage_type LIMIT 10) c), '[]'::jsonb),
            'claims', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', cl.id, 'status', cl.status, 'claimNote', cl.claim_note,
                'submittedAt', cl.submitted_at, 'decidedAt', cl.decided_at,
                'decisionNote', cl.decision_note, 'withdrawnAt', cl.withdrawn_at,
                'createdAt', cl.created_at)
                ORDER BY cl.created_at DESC, cl.id DESC)
                FROM (SELECT * FROM handyman_service_warranty_claims
                       WHERE warranty_id = w.id AND client_id = s."clientId"
                       ORDER BY created_at DESC, id DESC LIMIT 50) cl), '[]'::jsonb),
            'reworks', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', rw.id, 'status', rw.status, 'scopeNote', rw.scope_note,
                'proposedAt', rw.proposed_at, 'authorizedAt', rw.authorized_at,
                'startedAt', rw.started_at, 'completedAt', rw.completed_at,
                'completionNote', rw.completion_note, 'verifiedAt', rw.verified_at)
                ORDER BY rw.created_at DESC, rw.id DESC)
                FROM (SELECT * FROM handyman_service_warranty_reworks
                       WHERE warranty_id = w.id AND client_id = s."clientId"
                       ORDER BY created_at DESC, id DESC LIMIT 50) rw), '[]'::jsonb),
            'chargeableAdditionalWorks', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', aw.id, 'claimId', aw.claim_id, 'status', aw.status,
                'scopeNote', aw.scope_note, 'proposedAt', aw.proposed_at,
                'decidedAt', aw.decided_at, 'decidedByUserId', aw.decided_by_user_id,
                'paymentTriggerEmittedAt', aw.payment_trigger_emitted_at)
                ORDER BY aw.created_at DESC, aw.id DESC)
                FROM (SELECT * FROM handyman_chargeable_additional_works
                       WHERE warranty_id = w.id AND client_id = s."clientId"
                       ORDER BY created_at DESC, id DESC LIMIT 50) aw), '[]'::jsonb))
            FROM handyman_service_warranties w
           WHERE w.execution_scope_id = s."executionScopeId"
             AND w.client_id = s."clientId"
           LIMIT 1),
        'activityTimeline', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', e.id, 'eventType', e.event_type,
            'entityType', e.entity_type, 'entityId', e.entity_id,
            'summary', e.summary, 'occurredAt', e.occurred_at)
            ORDER BY e.occurred_at DESC, e.id DESC)
            FROM (
              SELECT oe.id, oe.event_type, oe.entity_type, oe.entity_id,
                     oe.summary, oe.occurred_at
                FROM operational_events oe
               WHERE oe.client_id = s."clientId"
                 AND oe.building_id = s."buildingId"
                 AND (oe.entity_type LIKE 'HANDYMAN_%'
                   OR oe.entity_type IN ('TENANT_INVOICE', 'EVIDENCE_SUBMISSION'))
                 AND oe.entity_id IN (
                   SELECT s."requestId"
                   UNION SELECT s."executionScopeId" WHERE s."executionScopeId" IS NOT NULL
                   UNION SELECT x.id FROM handyman_request_inspections x
                    WHERE x.handyman_request_id = s."requestId" AND x.client_id = s."clientId"
                   UNION SELECT q.id FROM handyman_quotations q WHERE q.handyman_request_id = s."requestId"
                   UNION SELECT v.id FROM handyman_quotation_versions v
                     JOIN handyman_quotations q ON q.id = v.quotation_id
                    WHERE q.handyman_request_id = s."requestId"
                   UNION SELECT sr.id FROM handyman_scheduling_readiness sr
                    WHERE sr.handyman_request_id = s."requestId"
                   UNION SELECT a.id FROM handyman_visit_appointments a
                    WHERE a.handyman_request_id = s."requestId" AND a.client_id = s."clientId"
                   UNION SELECT e.id FROM handyman_evidence_records e
                    WHERE e.execution_scope_id = s."executionScopeId" AND e.client_id = s."clientId"
                   UNION SELECT qr.id FROM handyman_qc_runs qr
                    WHERE qr.execution_scope_id = s."executionScopeId" AND qr.client_id = s."clientId"
                   UNION SELECT d.id FROM handyman_defect_records d
                    WHERE d.execution_scope_id = s."executionScopeId" AND d.client_id = s."clientId"
                   UNION SELECT b.id FROM handyman_bast_documents b
                    WHERE b.execution_scope_id = s."executionScopeId" AND b.client_id = s."clientId"
                   UNION SELECT i.id FROM tenant_invoices i
                    WHERE i.handyman_execution_scope_id = s."executionScopeId"
                   UNION SELECT w.id FROM handyman_service_warranties w
                    WHERE w.execution_scope_id = s."executionScopeId"
                   UNION SELECT wc.id FROM handyman_service_warranty_claims wc
                    JOIN handyman_service_warranties w ON w.id = wc.warranty_id
                    WHERE w.execution_scope_id = s."executionScopeId" AND wc.client_id = s."clientId"
                   UNION SELECT rw.id FROM handyman_service_warranty_reworks rw
                    JOIN handyman_service_warranties w ON w.id = rw.warranty_id
                    WHERE w.execution_scope_id = s."executionScopeId" AND rw.client_id = s."clientId"
                   UNION SELECT p.id FROM handyman_customer_payments p
                     JOIN handyman_customer_transactions tx ON tx.id = p.transaction_id
                    WHERE tx.execution_scope_id = s."executionScopeId"
                   UNION SELECT e.id FROM evidence_submissions e
                    WHERE e.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
                      AND e.execution_id IN (
                        SELECT p.id FROM handyman_customer_payments p
                          JOIN handyman_customer_transactions tx ON tx.id = p.transaction_id
                         WHERE tx.execution_scope_id = s."executionScopeId")
                 )
               ORDER BY oe.occurred_at DESC, oe.id DESC LIMIT 100
            ) e
        ), '[]'::jsonb)
      ) FROM selected s) AS data`,
    [principal.sessionId, principal.careActorId, principal.integrationId,
      selection.propertyId, null, 1, selection.tenantCompanyId,
      selection.buildingId, selection.spaceId, requestId]);
  return result.rows[0];
}

export const careWorkspaceOperationalRepository = { readOperationalProjection };
