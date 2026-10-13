# CR-HM-DB-OPT-01 — PostgreSQL table inventory

Generated from the migrated schema on an isolated PostgreSQL 16.14 scratch
database (all 434 migrations applied; 423 tables, 2054 indexes, 2672 foreign
keys). This appendix lists **every** table with its foreign-key relationships
and indexes. Human-curated purposes and hot-path notes are provided for the
core lifecycle/finance/audit/evidence tables named in the change request; the
remaining tables are listed with their FK/index facts and migration lineage.

## Scope-hierarchy legend

`clients → properties → buildings → spaces` with `tenant_companies` occupying
spaces. Every scoping query in the backend is expected to filter on these
identifiers (see `docs/data-isolation.md`). Handyman execution flows hang off
`handyman_service_requests` → execution scope → financial/evidence children.

## Focus tables (curated)

| Table | Purpose | Key relationships | Hot read/write paths |
| --- | --- | --- | --- |
| `work_orders` | Authoritative property Work Order lifecycle (BE-08) — OPEN→…→CLOSED with assignments, actions, SLA. | asset_id→assets.id<br>building_id→buildings.id<br>client_id→clients.id<br>completed_by_user_id→users.id<br>created_by_user_id→users.id<br>functional_location_id→functional_locations.id<br>work_request_id→work_requests.id | see audit report §query-callsites |
| `work_order_assignments` | Work Order assignment history (team/vendor/workforce), one ACTIVE per Work Order (partial unique). | assigned_by_user_id→users.id<br>team_id→teams.id<br>vendor_id→vendors.id<br>work_order_id→work_orders.id<br>workforce_profile_id→workforce_profiles.id | see audit report §query-callsites |
| `work_order_actions` | Append-only Work Order action trail (actor, type, occurred_at). | actor_user_id→users.id<br>work_order_id→work_orders.id | see audit report §query-callsites |
| `handyman_service_requests` | Authoritative Handyman customer request lifecycle (intake→triage→diagnosis→referral). No authoritative WorkOrder relation. | building_id→buildings.id<br>channel_attribution_id→handyman_channel_attributions.id<br>client_id→handyman_service_variants.client_id<br>client_id→handyman_service_variants.id<br>client_id→service_catalog.client_id<br>client_id→service_catalog.id<br>client_id→clients.id<br>created_by_user_id→users.id<br>service_catalog_id→service_catalog.id<br>service_catalog_id→service_catalog.client_id<br>service_variant_id→handyman_service_variants.id<br>service_variant_id→handyman_service_variants.client_id<br>space_id→spaces.id<br>tenant_company_id→tenant_companies.id<br>tenant_pic_id→tenant_pics.id | see audit report §query-callsites |
| `handyman_request_triage_decisions` | Frozen F1 triage decision per Handyman request (one row per request). | actor_user_id→users.id<br>building_id→buildings.id<br>channel_attribution_id→handyman_channel_attributions.id<br>client_id→handyman_service_requests.client_id<br>client_id→handyman_service_requests.id<br>client_id→clients.id<br>handyman_request_id→handyman_service_requests.id<br>handyman_request_id→handyman_service_requests.client_id | see audit report §query-callsites |
| `handyman_request_diagnoses` | Frozen F2 diagnosis per Handyman request (one row per request). | building_id→buildings.id<br>channel_attribution_id→handyman_channel_attributions.id<br>client_id→handyman_service_requests.id<br>client_id→handyman_service_requests.client_id<br>client_id→clients.id<br>diagnosed_by_user_id→users.id<br>handyman_discipline_id→handyman_disciplines.id<br>handyman_request_id→handyman_service_requests.id<br>handyman_request_id→handyman_service_requests.client_id<br>recommended_service_catalog_id→service_catalog.id | see audit report §query-callsites |
| `handyman_request_referrals` | Frozen F3 referral per Handyman request (one row per request). | building_id→buildings.id<br>channel_attribution_id→handyman_channel_attributions.id<br>client_id→handyman_service_requests.client_id<br>client_id→handyman_service_requests.id<br>client_id→clients.id<br>handyman_diagnosis_id→handyman_request_diagnoses.id<br>handyman_discipline_id→handyman_disciplines.id<br>handyman_request_id→handyman_service_requests.id<br>handyman_request_id→handyman_service_requests.client_id<br>referred_by_user_id→users.id | see audit report §query-callsites |
| `handyman_request_inspections` | Frozen F2 inspection record per Handyman request (append-only, trigger-guarded). | building_id→buildings.id<br>channel_attribution_id→handyman_channel_attributions.id<br>client_id→handyman_service_requests.id<br>client_id→handyman_service_requests.client_id<br>client_id→clients.id<br>handyman_request_id→handyman_service_requests.client_id<br>handyman_request_id→handyman_service_requests.id<br>inspected_by_user_id→users.id | see audit report §query-callsites |
| `handyman_visit_appointments` | Tenant visit appointments (INSPECTION/EXECUTION kinds, state machine, one live per request+kind). | building_id→buildings.id<br>cancelled_by_user_id→users.id<br>client_id→clients.id<br>client_id→handyman_service_requests.client_id<br>client_id→handyman_service_requests.id<br>confirmed_by_user_id→users.id<br>created_by_user_id→users.id<br>execution_scope_id→handyman_execution_scopes.id<br>handyman_request_id→handyman_service_requests.id<br>handyman_request_id→handyman_service_requests.client_id<br>supersedes_appointment_id→handyman_visit_appointments.id<br>tenant_company_id→tenant_companies.id | see audit report §query-callsites |
| `handyman_visit_attempts` | Append-only visit attempt outcomes with idempotency keys. | actor_user_id→users.id<br>appointment_id→handyman_visit_appointments.id | see audit report §query-callsites |
| `handyman_visit_capacity_reservations` | GiST exclusion capacity reservations (no double-book per resource window). | appointment_id→handyman_visit_appointments.client_id<br>appointment_id→handyman_visit_appointments.id<br>client_id→handyman_visit_appointments.id<br>client_id→handyman_visit_appointments.client_id | see audit report §query-callsites |
| `handyman_scheduling_readiness` | Readiness stage: scheduling readiness rows (one ACTIVE per request). | client_id→clients.id<br>created_by_user_id→users.id<br>handyman_request_id→handyman_service_requests.id<br>supersedes_readiness_id→handyman_scheduling_readiness.id | see audit report §query-callsites |
| `handyman_unit_access_readiness` | Readiness stage: unit-access readiness rows (one ACTIVE per request). | area_id→areas.id<br>authorized_by_user_id→users.id<br>building_id→buildings.id<br>client_id→clients.id<br>floor_id→floors.id<br>handyman_request_id→handyman_service_requests.id<br>room_id→rooms.id<br>space_id→spaces.id<br>supersedes_readiness_id→handyman_unit_access_readiness.id | see audit report §query-callsites |
| `handyman_permit_readiness` | Readiness stage: permit readiness rows (one ACTIVE per request). | area_id→areas.id<br>authorized_by_user_id→users.id<br>building_id→buildings.id<br>client_id→clients.id<br>floor_id→floors.id<br>handyman_request_id→handyman_service_requests.id<br>room_id→rooms.id<br>space_id→spaces.id<br>supersedes_readiness_id→handyman_permit_readiness.id | see audit report §query-callsites |
| `handyman_quotations` | One quotation per Handyman request; versioned issuance/decision. | client_id→handyman_service_requests.id<br>client_id→handyman_service_requests.client_id<br>client_id→clients.id<br>created_by_user_id→users.id<br>handyman_request_id→handyman_service_requests.id<br>handyman_request_id→handyman_service_requests.client_id | see audit report §query-callsites |
| `handyman_quotation_versions` | Quotation versions (one ISSUED per quotation); pricing snapshot. | created_by_user_id→users.id<br>quotation_id→handyman_quotations.id | see audit report §query-callsites |
| `handyman_quotation_lines` | Quotation line items (labor/material pricing composition). | created_by_user_id→users.id<br>quotation_version_id→handyman_quotation_versions.id<br>source_item_id→inventory_items.id<br>uom_id→units_of_measure.id | see audit report §query-callsites |
| `handyman_execution_scope_assignments` | Provider/crew assignment per execution scope (one ACTIVE per scope). | assigned_by_user_id→users.id<br>client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id<br>handyman_crew_id→handyman_work_crews.id<br>handyman_provider_context_id→handyman_provider_contexts.id<br>supersedes_assignment_id→handyman_execution_scope_assignments.id | see audit report §query-callsites |
| `handyman_arrival_verification_results` | Arrival verification results (QR + geofence evidence, status/reason pairs). | actor_user_id→users.id<br>assignment_id→handyman_execution_scope_assignments.id<br>challenge_id→handyman_arrival_challenges.id<br>client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id<br>expected_area_id→areas.id<br>expected_building_id→buildings.id<br>expected_floor_id→floors.id<br>expected_room_id→rooms.id<br>expected_space_id→spaces.id<br>geospatial_policy_id→handyman_building_geospatial_policies.id | see audit report §query-callsites |
| `handyman_work_sessions` | Worker check-in/out sessions (one open session per scope). | assignment_id→handyman_execution_scope_assignments.id<br>client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id<br>lead_user_id→users.id<br>lead_worker_id→handyman_worker_contexts.id | see audit report §query-callsites |
| `handyman_material_execution_lines` | Material execution lines settled against quotation lines. | client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id<br>quotation_line_id→handyman_quotation_lines.id<br>quotation_version_id→handyman_quotation_versions.id<br>source_item_id→inventory_items.id | see audit report §query-callsites |
| `handyman_qc_runs` | QC runs per execution scope (one OPEN per scope). | client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id<br>session_id→handyman_work_sessions.id | see audit report §query-callsites |
| `handyman_defect_records` | Defect records raised by QC per execution scope. | client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id<br>item_id→handyman_qc_run_items.id<br>run_id→handyman_qc_runs.id | see audit report §query-callsites |
| `handyman_bast_documents` | BAST (handover) documents per execution scope (one non-VOID per scope). | client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id | see audit report §query-callsites |
| `handyman_customer_transactions` | Customer ledger transaction (one per execution scope; currency-bound). | client_id→clients.id<br>created_by_user_id→users.id<br>execution_scope_id→handyman_execution_scopes.id<br>quotation_version_id→handyman_quotation_versions.id | see audit report §query-callsites |
| `handyman_charge_lines` | Charge composition lines per transaction (quotation-line-bound). | client_id→handyman_customer_transactions.id<br>client_id→clients.id<br>client_id→handyman_customer_transactions.client_id<br>created_by_user_id→users.id<br>currency→handyman_customer_transactions.id<br>currency→handyman_customer_transactions.currency<br>quotation_line_id→handyman_quotation_lines.id<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_transactions.currency<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_transactions.client_id | see audit report §query-callsites |
| `handyman_customer_payments` | Customer payment claims/events per transaction (external_reference idempotency). | client_id→handyman_customer_transactions.id<br>client_id→handyman_customer_transactions.client_id<br>client_id→clients.id<br>currency→handyman_customer_transactions.currency<br>currency→handyman_customer_transactions.id<br>decided_by_user_id→users.id<br>recorded_by_user_id→users.id<br>transaction_id→handyman_customer_transactions.currency<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_transactions.client_id | see audit report §query-callsites |
| `handyman_payment_allocations` | Payment allocations to charge lines (idempotency-keyed). | allocated_by_user_id→users.id<br>charge_line_id→handyman_charge_lines.transaction_id<br>charge_line_id→handyman_charge_lines.id<br>client_id→handyman_customer_transactions.id<br>client_id→clients.id<br>client_id→handyman_customer_transactions.client_id<br>currency→handyman_customer_transactions.currency<br>currency→handyman_customer_transactions.id<br>payment_id→handyman_customer_payments.transaction_id<br>payment_id→handyman_customer_payments.id<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_payments.transaction_id<br>transaction_id→handyman_customer_payments.id<br>transaction_id→handyman_customer_transactions.currency<br>transaction_id→handyman_charge_lines.id<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_charge_lines.transaction_id<br>transaction_id→handyman_customer_transactions.client_id | see audit report §query-callsites |
| `handyman_ledger_corrections` | Governed ledger corrections (append-only). | client_id→clients.id<br>client_id→handyman_customer_transactions.client_id<br>client_id→handyman_customer_transactions.id<br>corrected_by_user_id→users.id<br>currency→handyman_customer_transactions.currency<br>currency→handyman_customer_transactions.id<br>source_allocation_id→handyman_payment_allocations.id<br>source_allocation_id→handyman_payment_allocations.transaction_id<br>source_charge_line_id→handyman_charge_lines.id<br>source_charge_line_id→handyman_charge_lines.transaction_id<br>source_payment_id→handyman_customer_payments.id<br>source_payment_id→handyman_customer_payments.transaction_id<br>transaction_id→handyman_payment_allocations.transaction_id<br>transaction_id→handyman_customer_transactions.currency<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_transactions.client_id<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_payments.transaction_id<br>transaction_id→handyman_customer_payments.id<br>transaction_id→handyman_charge_lines.transaction_id<br>transaction_id→handyman_charge_lines.id<br>transaction_id→handyman_payment_allocations.id | see audit report §query-callsites |
| `handyman_settlement_units` | Settlement units over completed scopes. | actor_user_id→users.id<br>client_id→clients.id<br>client_id→handyman_customer_transactions.client_id<br>client_id→handyman_customer_transactions.id<br>currency→handyman_customer_transactions.currency<br>currency→handyman_customer_transactions.id<br>execution_scope_id→handyman_execution_scopes.id<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_transactions.client_id<br>transaction_id→handyman_customer_transactions.id<br>transaction_id→handyman_customer_transactions.currency | see audit report §query-callsites |
| `handyman_settlement_events` | Append-only settlement decision events. | actor_user_id→users.id<br>reconciliation_id→handyman_settlement_reconciliations.id<br>unit_id→handyman_settlement_units.id | see audit report §query-callsites |
| `handyman_service_warranties` | Service warranty per BAST (one per execution scope). | bast_id→handyman_bast_documents.id<br>client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id<br>started_by_user_id→users.id | see audit report §query-callsites |
| `handyman_service_warranty_claims` | Warranty claims per scope (open-claim uniqueness per warranty). | bast_id→handyman_bast_documents.id<br>bast_id→handyman_service_warranties.id<br>bast_id→handyman_service_warranties.bast_id<br>claimant_user_id→users.id<br>client_id→handyman_service_warranties.id<br>client_id→clients.id<br>client_id→handyman_service_warranties.client_id<br>decided_by_user_id→users.id<br>evidence_record_id→handyman_evidence_records.id<br>execution_scope_id→handyman_execution_scopes.id<br>opened_by_user_id→users.id<br>warranty_id→handyman_service_warranties.id<br>warranty_id→handyman_service_warranties.bast_id<br>warranty_id→handyman_service_warranties.client_id<br>warranty_id→handyman_service_warranties.id | see audit report §query-callsites |
| `handyman_service_warranty_reworks` | Warranty rework cycles per claim. | authorized_by_user_id→users.id<br>bast_id→handyman_service_warranties.id<br>bast_id→handyman_service_warranty_claims.id<br>bast_id→handyman_service_warranty_claims.bast_id<br>bast_id→handyman_bast_documents.id<br>bast_id→handyman_service_warranties.bast_id<br>claim_id→handyman_service_warranty_claims.warranty_id<br>claim_id→handyman_service_warranty_claims.id<br>claim_id→handyman_service_warranty_claims.execution_scope_id<br>claim_id→handyman_service_warranty_claims.bast_id<br>claim_id→handyman_service_warranty_claims.id<br>claim_id→handyman_service_warranty_claims.id<br>claim_id→handyman_service_warranty_claims.id<br>claim_id→handyman_service_warranty_claims.client_id<br>client_id→handyman_service_warranty_claims.client_id<br>client_id→clients.id<br>client_id→handyman_service_warranties.id<br>client_id→handyman_service_warranties.client_id<br>client_id→handyman_service_warranty_claims.id<br>execution_scope_id→handyman_execution_scopes.id<br>execution_scope_id→handyman_service_warranty_claims.id<br>execution_scope_id→handyman_service_warranty_claims.execution_scope_id<br>proposed_by_user_id→users.id<br>verification_evidence_record_id→handyman_evidence_records.id<br>verification_qc_run_id→handyman_qc_runs.id<br>verified_by_user_id→users.id<br>warranty_id→handyman_service_warranties.id<br>warranty_id→handyman_service_warranties.id<br>warranty_id→handyman_service_warranties.client_id<br>warranty_id→handyman_service_warranty_claims.warranty_id<br>warranty_id→handyman_service_warranty_claims.id<br>warranty_id→handyman_service_warranties.bast_id | see audit report §query-callsites |
| `handyman_chargeable_additional_works` | Chargeable additional work per claim. | bast_id→handyman_service_warranties.bast_id<br>bast_id→handyman_bast_documents.id<br>bast_id→handyman_service_warranty_claims.bast_id<br>bast_id→handyman_service_warranty_claims.id<br>bast_id→handyman_service_warranties.id<br>claim_id→handyman_service_warranty_claims.id<br>claim_id→handyman_service_warranty_claims.client_id<br>claim_id→handyman_service_warranty_claims.bast_id<br>claim_id→handyman_service_warranty_claims.id<br>claim_id→handyman_service_warranty_claims.execution_scope_id<br>claim_id→handyman_service_warranty_claims.id<br>claim_id→handyman_service_warranty_claims.warranty_id<br>claim_id→handyman_service_warranty_claims.id<br>client_id→handyman_service_warranty_claims.client_id<br>client_id→handyman_service_warranty_claims.id<br>client_id→clients.id<br>client_id→handyman_service_warranties.client_id<br>client_id→handyman_service_warranties.id<br>decided_by_user_id→users.id<br>execution_scope_id→handyman_service_warranty_claims.id<br>execution_scope_id→handyman_service_warranty_claims.execution_scope_id<br>execution_scope_id→handyman_execution_scopes.id<br>proposed_by_user_id→users.id<br>warranty_id→handyman_service_warranties.id<br>warranty_id→handyman_service_warranties.id<br>warranty_id→handyman_service_warranty_claims.warranty_id<br>warranty_id→handyman_service_warranties.bast_id<br>warranty_id→handyman_service_warranty_claims.id<br>warranty_id→handyman_service_warranties.client_id | see audit report §query-callsites |
| `handyman_evidence_records` | Handyman evidence record registry (scope/stage keyed). | client_id→clients.id<br>execution_scope_id→handyman_execution_scopes.id<br>session_id→handyman_work_sessions.id | see audit report §query-callsites |
| `handyman_evidence_record_files` | Files attached to Handyman evidence records. | record_id→handyman_evidence_records.id | see audit report §query-callsites |
| `evidence_submissions` | Shared evidence engine submissions (retention lifecycle, execution-typed). | client_id→clients.id<br>evidence_requirement_id→evidence_requirements.id<br>retention_hold_set_by_user_id→users.id<br>retention_policy_id→evidence_retention_policies.id<br>submitted_by_user_id→users.id | see audit report §query-callsites |
| `evidence_retention_policies` | Per-client/building retention policies driving the retention dispatcher. | building_id→buildings.id<br>client_id→clients.id | see audit report §query-callsites |
| `authentication_audit_events` | Append-only authentication audit trail (login/logout/invitation events). | actor_user_id→users.id<br>user_id→users.id | see audit report §query-callsites |
| `operational_events` | Append-only operational event log (entity-scoped, request correlation). | actor_user_id→users.id<br>building_id→buildings.id<br>client_id→clients.id<br>vendor_work_id→vendor_works.id | see audit report §query-callsites |
| `invoice_payment_status` | Invoice payment status projection (per invoice; building/tenant indexed). | building_id→buildings.id<br>client_id→clients.id<br>invoice_id→tenant_invoices.id<br>recorded_by_user_id→users.id<br>tenant_company_id→tenant_companies.id | see audit report §query-callsites |
| `invoice_payment_status_history` | Append-only payment-status history. | changed_by_user_id→users.id<br>invoice_payment_status_id→invoice_payment_status.id | see audit report §query-callsites |
| `payment_receipts` | Payment receipts per invoice (client-scoped receipt numbers). | building_id→buildings.id<br>client_id→clients.id<br>invoice_id→tenant_invoices.id<br>invoice_payment_status_id→invoice_payment_status.id<br>issued_by_user_id→users.id<br>tenant_company_id→tenant_companies.id<br>voided_by_user_id→users.id | see audit report §query-callsites |
| `tenant_invoices` | Tenant invoices (client-scoped numbering; Handyman-scope bound unique). | building_id→buildings.id<br>cancelled_by_user_id→users.id<br>client_id→clients.id<br>created_by_user_id→users.id<br>finalized_by_user_id→users.id<br>handyman_execution_scope_id→handyman_execution_scopes.id<br>space_id→spaces.id<br>tenant_company_id→tenant_companies.id | see audit report §query-callsites |
| `tenant_charges` | Tenant charge ledger rows. | building_id→buildings.id<br>cancelled_by_user_id→users.id<br>client_id→clients.id<br>created_by_user_id→users.id<br>space_id→spaces.id<br>tenant_company_id→tenant_companies.id | see audit report §query-callsites |
| `applied_slas` | SLA applied to Work Orders / Handyman subjects (response/resolution targets). | building_id→buildings.id<br>client_id→clients.id<br>sla_definition_id→sla_definitions.id<br>work_order_id→work_orders.id | see audit report §query-callsites |
| `sla_clocks` | Running/satisfied/breached SLA clocks (breach dispatcher target). | applied_sla_id→applied_slas.id | see audit report §query-callsites |
| `notification_reminders` | Due notification reminders (dispatcher queue; bounded retrieval). | client_id→clients.id<br>template_key→notification_templates.key | see audit report §query-callsites |
| `notification_escalations` | Due notification escalations (dispatcher queue; bounded retrieval). | client_id→clients.id<br>current_recipient_user_id→users.id<br>template_key→notification_templates.key | see audit report §query-callsites |
| `notification_outbound_deliveries` | Outbound omnichannel delivery queue with retry scheduling. | building_id→buildings.id<br>client_id→clients.id<br>recipient_user_id→users.id<br>template_key→notification_templates.key | see audit report §query-callsites |
| `integration_outbox_events` | Integration outbox (dispatcher fan-out source). | building_id→buildings.id<br>client_id→clients.id<br>operational_event_id→operational_events.id | see audit report §query-callsites |
| `integration_webhook_deliveries` | Webhook delivery queue with retry scheduling. | building_id→buildings.id<br>client_id→clients.id<br>endpoint_id→integration_webhook_endpoints.id<br>outbox_event_id→integration_outbox_events.id | see audit report §query-callsites |
| `reviews` | Approval/review records for findings, corrective actions, documents (PENDING uniqueness per type). | client_id→clients.id<br>reviewer_user_id→users.id | see audit report §query-callsites |
| `documents` | Document registry (client/building scoped, expiry tracked). | archived_by_user_id→users.id<br>building_id→buildings.id<br>client_id→clients.id<br>created_by_user_id→users.id | see audit report §query-callsites |
| `document_versions` | Immutable document versions (one per version number). | created_by_user_id→users.id<br>document_id→documents.id | see audit report §query-callsites |
| `users` | User accounts. | — | see audit report §query-callsites |
| `roles` | Role definitions. | — | see audit report §query-callsites |
| `permissions` | Permission codes. | — | see audit report §query-callsites |
| `role_permission_assignments` | Role→permission grants. | permission_id→permissions.id<br>role_id→roles.id | see audit report §query-callsites |
| `user_role_assignments` | User→role grants. | role_id→roles.id<br>user_id→users.id | see audit report §query-callsites |
| `user_sessions` | Active user sessions. | user_id→users.id | see audit report §query-callsites |
| `clients` | Tenant-client organizations (top of the scope hierarchy). | currency_code→currencies.code | see audit report §query-callsites |
| `properties` | Properties under a client. | client_id→clients.id | see audit report §query-callsites |
| `buildings` | Buildings under a property. | campus_id→campuses.id<br>property_id→properties.id | see audit report §query-callsites |
| `tenant_companies` | Tenant companies occupying spaces. | client_id→clients.id | see audit report §query-callsites |
| `spaces` | Leasable spaces/units. | room_id→rooms.id | see audit report §query-callsites |

## Full inventory (all 423 tables)

### `acceptance_sign_offs`

- FKs: bast_document_id→bast_documents, bast_submission_attempt_id→bast_submission_attempts, building_id→buildings, client_id→clients, document_version_id→document_versions, handover_document_id→handover_documents, signer_user_id→users
- Referenced by: bast_finding_links
- Indexes (10):
  - (bast_submission_attempt_id, signed_at DESC)
  - UNIQUE (bast_submission_attempt_id) WHERE (bast_submission_attempt_id IS NOT NULL)
  - (bast_document_id, signed_at DESC)
  - (building_id, decision)
  - (client_id, signed_at DESC)
  - (context_type, decision)
  - (document_version_id)
  - (handover_document_id, signed_at DESC)
  - UNIQUE (id)
  - (signer_user_id, signed_at DESC)

### `applied_slas`

SLA applied to Work Orders / Handyman subjects (response/resolution targets).

- FKs: building_id→buildings, client_id→clients, sla_definition_id→sla_definitions, work_order_id→work_orders
- Referenced by: sla_clocks, sla_escalation_actions
- Indexes (4):
  - (client_id, building_id, applied_at)
  - UNIQUE (id)
  - UNIQUE (subject_id) WHERE (subject_id IS NOT NULL)
  - UNIQUE (work_order_id)

### `areas`

- FKs: floor_id→floors
- Referenced by: cleaning_areas, handyman_arrival_location_identifiers, handyman_arrival_verification_results, handyman_execution_scopes, handyman_permit_readiness, handyman_unit_access_readiness, housekeeping_finding_links, incidents, patrol_route_points, permit_work_contexts, public_area_inspection_bindings, rooms, security_posts
- Indexes (4):
  - UNIQUE (floor_id, code)
  - (floor_id)
  - UNIQUE (id)
  - (status)

### `asset_categories`

- FKs: client_id→clients
- Referenced by: asset_types, assets
- Indexes (4):
  - UNIQUE (client_id, code)
  - (client_id)
  - UNIQUE (id)
  - (status)

### `asset_certifications`

- FKs: asset_id→assets
- Referenced by: permit_equipment
- Indexes (7):
  - (asset_id)
  - UNIQUE (asset_id, certificate_number)
  - (expiry_date)
  - UNIQUE (asset_id, certification_type) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (status)
  - (certification_type)

### `asset_failure_incidents`

- FKs: asset_id→assets, created_by_user_id→users, incident_id→incidents
- Referenced by: none
- Indexes (7):
  - (asset_id, occurred_at DESC)
  - (failure_category, failure_status)
  - UNIQUE (incident_id)
  - (incident_id)
  - (occurred_at DESC)
  - UNIQUE (id)
  - (failure_status, occurred_at DESC)

### `asset_history_events`

- FKs: actor_user_id→users, asset_id→assets
- Referenced by: none
- Indexes (4):
  - (actor_user_id)
  - (asset_id, created_at DESC)
  - (event_type)
  - UNIQUE (id)

### `asset_identifiers`

- FKs: asset_id→assets
- Referenced by: permit_equipment
- Indexes (5):
  - (asset_id)
  - UNIQUE (asset_id, identifier_type) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (status)
  - UNIQUE (identifier_value)

### `asset_types`

- FKs: asset_category_id→asset_categories
- Referenced by: assets
- Indexes (5):
  - (asset_category_id)
  - UNIQUE (asset_category_id, code)
  - UNIQUE (id, asset_category_id)
  - UNIQUE (id)
  - (status)

### `asset_warranties`

- FKs: asset_id→assets
- Referenced by: none
- Indexes (6):
  - (asset_id)
  - UNIQUE (asset_id, warranty_number)
  - (end_date)
  - UNIQUE (asset_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (status)

### `assets`

- FKs: asset_category_id→asset_categories, asset_category_id→asset_types, asset_category_id→asset_types, asset_type_id→asset_types, asset_type_id→asset_types, building_id→buildings, client_id→clients, functional_location_id→functional_locations, operational_state_changed_by_user_id→users
- Referenced by: asset_certifications, asset_failure_incidents, asset_history_events, asset_identifiers, asset_warranties, breakdown_bindings, engineering_checklist_bindings, engineering_finding_links, equipment_profiles, inspection_bindings, inventory_asset_spare_parts, log_sheet_bindings, maintenance_bindings, meter_reading_bindings, permit_equipment, work_orders
- Indexes (9):
  - (asset_category_id)
  - (asset_type_id)
  - (building_id)
  - UNIQUE (client_id, asset_code)
  - (client_id)
  - UNIQUE (client_id, serial_number) WHERE (serial_number IS NOT NULL)
  - (functional_location_id)
  - UNIQUE (id)
  - (status)

### `attendance_records`

- FKs: building_id→buildings, client_id→clients, shift_id→shifts, workforce_profile_id→workforce_profiles, workforce_shift_assignment_id→workforce_shift_assignments
- Referenced by: none
- Indexes (5):
  - UNIQUE (workforce_profile_id) WHERE (status = 'CLOCKED_IN'::text)
  - (building_id)
  - UNIQUE (id)
  - (status)
  - (workforce_profile_id)

### `authentication_audit_events`

Append-only authentication audit trail (login/logout/invitation events).

- FKs: actor_user_id→users, user_id→users
- Referenced by: none
- Indexes (4):
  - (created_at)
  - (event_type)
  - UNIQUE (id)
  - (user_id)

### `basic_expense_history`

- FKs: basic_expense_id→basic_expenses, changed_by_user_id→users
- Referenced by: none
- Indexes (2):
  - (basic_expense_id, changed_at)
  - UNIQUE (id)

### `basic_expenses`

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, created_by_user_id→users, finalized_by_user_id→users, vendor_service_cost_id→vendor_service_costs
- Referenced by: basic_expense_history, operational_budget_source_bindings
- Indexes (6):
  - (building_id, expense_date DESC)
  - (expense_category, expense_date DESC)
  - UNIQUE (client_id, expense_number)
  - UNIQUE (id)
  - (status, expense_date DESC)
  - (vendor_service_cost_id)

### `bast_documents`

- FKs: accepted_by_user_id→users, building_id→buildings, client_id→clients, completion_report_id→vendor_completion_reports, document_id→documents, prepared_by_user_id→users, service_report_id→vendor_service_reports, submitted_by_user_id→users, vendor_id→vendors, vendor_work_id→vendor_works, work_completion_document_id→work_completion_documents, work_order_id→work_orders
- Referenced by: acceptance_sign_offs, bast_finding_links, bast_reconciliation_quarantines, bast_submission_attempts, handover_documents, vendor_bast_bindings, vendor_invoices
- Indexes (15):
  - (acceptance_scope_type, work_order_id, vendor_work_id)
  - (building_id, acceptance_status)
  - (client_id, acceptance_status)
  - UNIQUE (client_id, bast_number)
  - (completion_report_id)
  - (context_type, acceptance_status)
  - UNIQUE (document_id)
  - (document_id)
  - UNIQUE (id)
  - (service_report_id)
  - (vendor_id, acceptance_status)
  - (vendor_work_id, acceptance_status)
  - UNIQUE (vendor_work_id) WHERE (vendor_work_id IS NOT NULL)
  - (work_completion_document_id)
  - (work_order_id, acceptance_status)

### `bast_finding_links`

- FKs: acceptance_sign_off_id→acceptance_sign_offs, bast_document_id→bast_documents, bast_submission_attempt_id→bast_submission_attempts, finding_id→findings, linked_by_user_id→users
- Referenced by: none
- Indexes (5):
  - UNIQUE (bast_document_id, finding_id, bast_submission_attempt_id)
  - (bast_submission_attempt_id)
  - (bast_document_id, linked_at DESC)
  - (finding_id)
  - UNIQUE (id)

### `bast_reconciliation_quarantines`

- FKs: bast_document_id→bast_documents, created_by_user_id→users, resolved_by_user_id→users, vendor_bast_binding_id→vendor_bast_bindings
- Referenced by: none
- Indexes (4):
  - (bast_document_id, status)
  - (vendor_bast_binding_id, status)
  - UNIQUE (id)
  - (status, created_at DESC)

### `bast_submission_attempt_evidence`

- FKs: evidence_submission_id→evidence_submissions, submission_attempt_id→bast_submission_attempts
- Referenced by: none
- Indexes (2):
  - UNIQUE (submission_attempt_id, evidence_submission_id)
  - (evidence_submission_id)

### `bast_submission_attempts`

- FKs: bast_document_id→bast_documents, completion_report_id→vendor_completion_reports, document_version_id→document_versions, service_report_id→vendor_service_reports, submitted_by_user_id→users, vendor_work_verification_id→reviews, work_completion_document_id→work_completion_documents, work_order_verification_id→reviews
- Referenced by: acceptance_sign_offs, bast_finding_links, bast_submission_attempt_evidence
- Indexes (5):
  - UNIQUE (bast_document_id, attempt_number)
  - (bast_document_id, attempt_number DESC)
  - UNIQUE (id)
  - (submitted_at DESC)
  - (document_version_id)

### `breakdown_bindings`

- FKs: asset_id→assets, building_id→buildings, client_id→clients, functional_location_id→functional_locations, reported_by_user_id→users, work_order_id→work_orders
- Referenced by: none
- Indexes (5):
  - (asset_id, status)
  - (building_id, status)
  - UNIQUE (id)
  - UNIQUE (work_order_id)
  - (work_order_id)

### `building_configurations`

- FKs: building_id→buildings
- Referenced by: none
- Indexes (3):
  - UNIQUE (building_id, key)
  - (building_id, status, key)
  - UNIQUE (id)

### `building_utility_reconciliations`

- FKs: building_id→buildings, calculated_by_user_id→users, client_id→clients, uom_id→units_of_measure
- Referenced by: utility_operational_exceptions
- Indexes (4):
  - (building_id, utility_type, period_end DESC)
  - (client_id, building_id, period_end DESC)
  - UNIQUE (client_id, building_id, utility_type, period_start, period_end)
  - UNIQUE (id)

### `buildings`

Buildings under a property.

- FKs: campus_id→campuses, property_id→properties
- Referenced by: acceptance_sign_offs, applied_slas, assets, attendance_records, basic_expenses, bast_documents, breakdown_bindings, building_configurations, building_utility_reconciliations, checklist_configuration_bindings, cleaning_areas, cleaning_schedule_bindings, cms_content, configuration_preview_contexts, configuration_versions, consumable_readiness_checks, consumable_requirements, contractor_visitors, dashboards, delivery_couriers, documents, engineering_checklist_bindings, engineering_finding_links, esg_baselines, esg_metric_values, esg_targets, esg_waste_records, evidence_retention_policies, expected_visitors, feature_entitlement_configurations, findings, floors, form_configuration_bindings, functional_locations, generated_tasks, handover_documents, handyman_arrival_location_identifiers, handyman_arrival_verification_results, handyman_building_geospatial_policies, handyman_channel_attributions, handyman_execution_scopes, handyman_handoff_exchanges, handyman_permit_readiness, handyman_request_diagnoses, handyman_request_inspections, handyman_request_referrals, handyman_request_triage_decisions, handyman_service_requests, handyman_unit_access_readiness, handyman_visit_appointments, host_confirmations, housekeeping_complaint_bindings, housekeeping_finding_links, incidents, inspection_bindings, integration_outbox_events, integration_webhook_deliveries, integration_webhook_endpoints, inventory_asset_spare_parts, inventory_housekeeping_consumable_bindings, inventory_material_reservations, inventory_minimum_stocks, inventory_stock_adjustments, inventory_stock_balances, inventory_stock_movements, inventory_stock_transfers, inventory_warehouses, inventory_work_order_material_usages, invoice_payment_status, log_sheet_bindings, maintenance_bindings, material_requests, meter_reading_bindings, module_configurations, navigation_items, notification_event_subscriptions, notification_outbound_deliveries, notification_push_deliveries, operational_budget_source_bindings, operational_budgets, operational_commitments, operational_events, patrol_checklist_bindings, patrol_point_visits, patrol_route_points, patrol_routes, patrol_schedule_bindings, payment_receipts, permit_work_contexts, permits, price_catalog_entries, procurement_approval_bindings, public_area_inspection_bindings, purchase_order_lines, purchase_order_readiness, purchase_orders, purchase_requests, quality_audits, receivings, report_archives, rfq_comparison_evidence, rfq_comparison_runs, safety_inspection_bindings, schedule_definitions, security_finding_links, security_incident_readiness, security_keys, security_logbook_entries, security_lost_found, security_posts, security_shift_handover_bindings, security_visitor_bindings, service_charge_readiness, service_requests, shift_handovers, shifts, sla_definitions, sla_escalation_actions, sla_escalation_policies, supervisor_inspections, supporting_documents, tenant_approval_bindings, tenant_building_contexts, tenant_charges, tenant_communications, tenant_complaints, tenant_contractor_relationships, tenant_documents, tenant_invoices, tenant_service_requests, tenant_space_relationships, tenant_utility_requests, toilet_inspection_bindings, user_building_assignments, utility_abnormal_consumptions, utility_bills, utility_calculation_bases, utility_calculations, utility_meter_consumptions, utility_meter_ocr_candidates, utility_meter_readings, utility_meter_tenant_assignments, utility_meters, utility_operational_exceptions, utility_reading_dues, vendor_assignments, vendor_bast_bindings, vendor_building_relationships, vendor_checklist_bindings, vendor_completion_reports, vendor_invoices, vendor_selection_readiness, vendor_service_costs, vendor_service_reports, vendor_works, visit_check_ins, visitor_invitations, visitor_passes, walk_in_visits, work_completion_documents, work_contracts, work_order_procurement_bindings, work_orders, work_permit_readiness, work_requests, workforce_building_assignments, workspaces
- Indexes (5):
  - (campus_id)
  - UNIQUE (id)
  - UNIQUE (property_id, code)
  - (property_id)
  - (status)

### `campuses`

- FKs: property_id→properties
- Referenced by: buildings
- Indexes (4):
  - UNIQUE (id)
  - UNIQUE (property_id, code)
  - (property_id)
  - (status)

### `checklist_configuration_bindings`

- FKs: building_id→buildings, checklist_template_id→checklist_templates, client_id→clients
- Referenced by: none
- Indexes (4):
  - UNIQUE (building_id, checklist_template_id) WHERE (scope_type = 'BUILDING'::text)
  - UNIQUE (client_id, checklist_template_id) WHERE (scope_type = 'CLIENT'::text)
  - UNIQUE (id)
  - (checklist_template_id)

### `checklist_executions`

- FKs: assigned_team_id→teams, assigned_workforce_profile_id→workforce_profiles, checklist_template_id→checklist_templates, client_id→clients, completed_by_user_id→users, engineering_checklist_binding_id→engineering_checklist_bindings, generated_task_id→generated_tasks, inspection_binding_id→inspection_bindings, patrol_checklist_binding_id→patrol_checklist_bindings, public_area_inspection_binding_id→public_area_inspection_bindings, toilet_inspection_binding_id→toilet_inspection_bindings
- Referenced by: checklist_item_responses, permit_equipment, permit_safety_requirements, vendor_checklist_bindings
- Indexes (10):
  - (client_id, created_at)
  - (engineering_checklist_binding_id)
  - (generated_task_id)
  - UNIQUE (generated_task_id) WHERE (generated_task_id IS NOT NULL)
  - (inspection_binding_id)
  - (patrol_checklist_binding_id)
  - UNIQUE (id)
  - (public_area_inspection_binding_id)
  - (checklist_template_id)
  - (toilet_inspection_binding_id)

### `checklist_item_options`

- FKs: checklist_item_id→checklist_items
- Referenced by: none
- Indexes (3):
  - UNIQUE (checklist_item_id, code)
  - (checklist_item_id, display_order)
  - UNIQUE (id)

### `checklist_item_responses`

- FKs: checklist_execution_id→checklist_executions, checklist_item_id→checklist_items, last_responded_by_user_id→users
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (checklist_execution_id, checklist_item_id)
  - (checklist_execution_id)

### `checklist_items`

- FKs: checklist_template_id→checklist_templates, uom_id→units_of_measure
- Referenced by: checklist_item_options, checklist_item_responses
- Indexes (3):
  - UNIQUE (checklist_template_id, code)
  - UNIQUE (id)
  - (checklist_template_id, display_order)

### `checklist_templates`

- FKs: client_id→clients
- Referenced by: checklist_configuration_bindings, checklist_executions, checklist_items, engineering_checklist_bindings, inspection_bindings, patrol_checklist_bindings, permit_safety_requirements, public_area_inspection_bindings, toilet_inspection_bindings, vendor_checklist_bindings
- Indexes (3):
  - UNIQUE (client_id, code)
  - (client_id, status)
  - UNIQUE (id)

### `cleaning_areas`

- FKs: area_id→areas, building_id→buildings, client_id→clients, floor_id→floors, functional_location_id→functional_locations, room_id→rooms, space_id→spaces
- Referenced by: cleaning_schedule_bindings, consumable_requirements, housekeeping_complaint_bindings, housekeeping_finding_links, inventory_housekeeping_consumable_bindings, public_area_inspection_bindings, quality_audits, supervisor_inspections, toilet_inspection_bindings
- Indexes (9):
  - (area_id)
  - UNIQUE (building_id, code)
  - (building_id, status)
  - (client_id, status)
  - (floor_id)
  - (functional_location_id)
  - UNIQUE (id)
  - (room_id)
  - (space_id)

### `cleaning_schedule_bindings`

- FKs: building_id→buildings, cleaning_area_id→cleaning_areas, client_id→clients, created_by_user_id→users, schedule_definition_id→schedule_definitions
- Referenced by: none
- Indexes (7):
  - UNIQUE (cleaning_area_id, schedule_definition_id) WHERE (status = 'ACTIVE'::text)
  - (cleaning_area_id, status)
  - (building_id, status)
  - (client_id, status)
  - UNIQUE (id)
  - UNIQUE (schedule_definition_id) WHERE (status = 'ACTIVE'::text)
  - (schedule_definition_id)

### `client_allowed_transaction_currencies`

- FKs: client_id→clients, currency_code→currencies
- Referenced by: none
- Indexes (2):
  - (currency_code)
  - UNIQUE (client_id, currency_code)

### `client_configurations`

- FKs: client_id→clients
- Referenced by: none
- Indexes (3):
  - UNIQUE (client_id, key)
  - (client_id, status, key)
  - UNIQUE (id)

### `client_fx_policies`

- FKs: client_id→clients, created_by_user_id→users, reporting_currency_code→currencies, updated_by_user_id→users
- Referenced by: none
- Indexes (1):
  - UNIQUE (client_id)

### `client_monetary_contexts`

- FKs: base_currency_code→currencies, client_id→clients, default_transaction_currency_code→currencies
- Referenced by: none
- Indexes (1):
  - UNIQUE (client_id)

### `clients`

Tenant-client organizations (top of the scope hierarchy).

- FKs: currency_code→currencies
- Referenced by: acceptance_sign_offs, applied_slas, asset_categories, assets, attendance_records, basic_expenses, bast_documents, breakdown_bindings, building_utility_reconciliations, checklist_configuration_bindings, checklist_executions, checklist_templates, cleaning_areas, cleaning_schedule_bindings, client_allowed_transaction_currencies, client_configurations, client_fx_policies, client_monetary_contexts, cms_content, configuration_preview_contexts, configuration_versions, consumable_readiness_checks, consumable_requirements, contractor_visitors, dashboards, delivery_couriers, documents, engineering_checklist_bindings, engineering_finding_links, esg_baselines, esg_metric_definitions, esg_metric_values, esg_targets, esg_waste_records, evidence_requirements, evidence_retention_policies, evidence_submissions, expected_visitors, external_organizations, feature_entitlement_configurations, finding_classifications, finding_severities, findings, form_configuration_bindings, form_instances, form_templates, generated_tasks, handover_documents, handyman_arrival_challenges, handyman_arrival_location_identifiers, handyman_arrival_verification_results, handyman_bast_documents, handyman_bast_events, handyman_bast_sign_offs, handyman_bm_fee_beneficiary_definitions, handyman_building_geospatial_policies, handyman_channel_attributions, handyman_charge_line_bases, handyman_charge_lines, handyman_chargeable_additional_work_events, handyman_chargeable_additional_works, handyman_commercial_agreement_events, handyman_commercial_agreements, handyman_common_material_profiles, handyman_crew_leads, handyman_crew_memberships, handyman_customer_payment_events, handyman_customer_payments, handyman_customer_transaction_events, handyman_customer_transactions, handyman_defect_events, handyman_defect_records, handyman_discipline_service_associations, handyman_entitlement_facts, handyman_evidence_record_events, handyman_evidence_records, handyman_execution_scope_assignments, handyman_execution_scopes, handyman_handoff_exchanges, handyman_ledger_corrections, handyman_material_execution_events, handyman_material_execution_lines, handyman_payment_allocations, handyman_permit_readiness, handyman_provider_contexts, handyman_qc_run_events, handyman_qc_runs, handyman_quotation_decisions, handyman_quotations, handyman_request_diagnoses, handyman_request_inspections, handyman_request_referrals, handyman_request_triage_decisions, handyman_scheduling_readiness, handyman_service_requests, handyman_service_variants, handyman_service_warranties, handyman_service_warranty_claim_events, handyman_service_warranty_claims, handyman_service_warranty_coverages, handyman_service_warranty_events, handyman_service_warranty_rework_events, handyman_service_warranty_reworks, handyman_settlement_units, handyman_unit_access_readiness, handyman_visit_appointments, handyman_work_crews, handyman_work_session_events, handyman_work_session_helper_presence, handyman_work_sessions, handyman_worker_contexts, host_confirmations, housekeeping_complaint_bindings, housekeeping_finding_links, incidents, inspection_bindings, integration_outbox_events, integration_webhook_deliveries, integration_webhook_endpoints, inventory_asset_spare_parts, inventory_housekeeping_consumable_bindings, inventory_items, inventory_material_reservations, inventory_minimum_stocks, inventory_stock_adjustments, inventory_stock_balances, inventory_stock_movements, inventory_stock_transfers, inventory_warehouses, inventory_work_order_material_usages, invoice_payment_status, log_sheet_bindings, maintenance_bindings, material_requests, meter_reading_bindings, module_configurations, navigation_items, notification_email_deliveries, notification_escalations, notification_event_subscriptions, notification_outbound_deliveries, notification_push_deliveries, notification_reminders, notification_secure_links, notification_whatsapp_deliveries, notifications, operational_budget_source_bindings, operational_budgets, operational_commitments, operational_events, organizations, patrol_checklist_bindings, patrol_point_visits, patrol_route_points, patrol_routes, patrol_schedule_bindings, payment_receipts, permits, platform_support_sessions, price_catalog_entries, procurement_approval_bindings, properties, public_area_inspection_bindings, purchase_order_lines, purchase_order_readiness, purchase_orders, purchase_requests, quality_audits, receivings, report_archives, reviews, rfq_comparison_evidence, rfq_comparison_runs, room_types, saas_billing_accounts, saas_invoices, saas_payment_allocations, saas_payment_records, saas_provisioning_runs, saas_usage_aggregations, saas_usage_records, safety_inspection_bindings, schedule_definitions, security_finding_links, security_incident_readiness, security_keys, security_logbook_entries, security_lost_found, security_posts, security_shift_handover_bindings, security_visitor_bindings, service_catalog, service_charge_readiness, service_requests, shift_handovers, shifts, skills, sla_definitions, sla_escalation_actions, sla_escalation_policies, source_forms, subscriptions, supervisor_inspections, supporting_documents, tenant_approval_bindings, tenant_charges, tenant_communications, tenant_companies, tenant_complaints, tenant_contractor_relationships, tenant_documents, tenant_invoices, tenant_service_requests, tenant_utility_requests, toilet_inspection_bindings, units_of_measure, utility_abnormal_consumptions, utility_abnormality_rules, utility_bills, utility_calculation_bases, utility_calculations, utility_meter_consumptions, utility_meter_hierarchies, utility_meter_ocr_candidates, utility_meter_readings, utility_meter_tenant_assignments, utility_meters, utility_operational_exceptions, utility_reading_dues, utility_type_configurations, vendor_bast_bindings, vendor_categories, vendor_checklist_bindings, vendor_completion_reports, vendor_invoices, vendor_selection_readiness, vendor_service_costs, vendor_service_reports, vendors, visit_check_ins, visitor_invitations, visitor_passes, visitor_photos, visitors, walk_in_visits, work_completion_documents, work_contracts, work_order_procurement_bindings, work_orders, work_permit_readiness, work_requests, workspaces
- Indexes (4):
  - UNIQUE (billing_email) WHERE (billing_email IS NOT NULL)
  - UNIQUE (code)
  - UNIQUE (id)
  - (status)

### `cms_content`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, published_by_user_id→users
- Referenced by: none
- Indexes (5):
  - (building_id, status, content_type, slug) WHERE (scope_type = 'BUILDING'::text)
  - UNIQUE (building_id, content_type, slug) WHERE (scope_type = 'BUILDING'::text)
  - (client_id, status, content_type, slug) WHERE (scope_type = 'CLIENT'::text)
  - UNIQUE (client_id, content_type, slug) WHERE (scope_type = 'CLIENT'::text)
  - UNIQUE (id)

### `configuration_preview_contexts`

- FKs: building_id→buildings, client_id→clients, configuration_version_id→configuration_versions, created_by_user_id→users, revoked_by_user_id→users
- Referenced by: none
- Indexes (4):
  - (created_by_user_id, status, expires_at)
  - (client_id, building_id)
  - (configuration_version_id)
  - UNIQUE (id)

### `configuration_version_transitions`

- FKs: configuration_version_id→configuration_versions, transitioned_by_user_id→users
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (configuration_version_id, transitioned_at)

### `configuration_version_validations`

- FKs: configuration_version_id→configuration_versions, validated_by_user_id→users
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (configuration_version_id, validated_at DESC)

### `configuration_versions`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, previous_version_id→configuration_versions
- Referenced by: configuration_preview_contexts, configuration_version_transitions, configuration_version_validations, configuration_versions
- Indexes (6):
  - (building_id, created_at DESC)
  - (client_id, created_at DESC)
  - UNIQUE (source_type, source_configuration_id) WHERE (lifecycle_status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (source_type, source_configuration_id, version_number DESC)
  - UNIQUE (source_type, source_configuration_id, version_number)

### `consumable_readiness_checks`

- FKs: building_id→buildings, checked_by_user_id→users, client_id→clients, requirement_id→consumable_requirements
- Referenced by: none
- Indexes (4):
  - (building_id, readiness_status)
  - UNIQUE (id)
  - (operational_date)
  - (requirement_id, checked_at DESC)

### `consumable_requirements`

- FKs: building_id→buildings, cleaning_area_id→cleaning_areas, client_id→clients
- Referenced by: consumable_readiness_checks, inventory_housekeeping_consumable_bindings
- Indexes (5):
  - (cleaning_area_id, status)
  - (building_id, status)
  - (client_id, status)
  - UNIQUE (building_id, code)
  - UNIQUE (id)

### `contractor_visitors`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, expected_visitor_id→expected_visitors, functional_location_id→functional_locations, responsible_host_user_id→users, responsible_host_workforce_id→workforce_profiles, visitor_id→visitors, walk_in_visit_id→walk_in_visits
- Referenced by: none
- Indexes (9):
  - (building_id, status, created_at)
  - (client_id, status)
  - UNIQUE (expected_visitor_id) WHERE (expected_visitor_id IS NOT NULL)
  - (responsible_host_user_id)
  - (responsible_host_workforce_id)
  - (functional_location_id)
  - UNIQUE (id)
  - (visitor_id, status)
  - UNIQUE (walk_in_visit_id) WHERE (walk_in_visit_id IS NOT NULL)

### `corrective_action_responsibilities`

- FKs: assigned_by_user_id→users, corrective_action_id→corrective_actions, released_by_user_id→users, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (5):
  - UNIQUE (corrective_action_id) WHERE (status = 'ACTIVE'::text)
  - (corrective_action_id, status, assigned_at DESC)
  - (assigned_by_user_id, assigned_at)
  - UNIQUE (id)
  - (workforce_profile_id, status)

### `corrective_actions`

- FKs: approved_by_user_id→users, cancelled_by_user_id→users, completed_by_user_id→users, created_by_user_id→users, due_date_set_by_user_id→users, incident_id→incidents, rejected_by_user_id→users, verified_by_user_id→users
- Referenced by: corrective_action_responsibilities
- Indexes (7):
  - (due_date) WHERE (due_date IS NOT NULL)
  - (incident_id, proposed_at DESC)
  - (status, due_date) WHERE ((due_date IS NOT NULL) AND (status = ANY (ARRAY['PROPOSED'::text, 'APPROVED'::text, 'IN_PROGRESS'::text])))
  - UNIQUE (id)
  - (status, proposed_at DESC)
  - (action_type, status)
  - (status, verified_at) WHERE (status = 'VERIFIED'::text)

### `currencies`

- FKs: none
- Referenced by: client_allowed_transaction_currencies, client_fx_policies, client_monetary_contexts, clients, fx_rates, saas_billing_accounts, saas_invoice_lines, saas_invoices, saas_payment_allocations, saas_payment_records, saas_price_items, saas_pricebooks, subscriptions
- Indexes (1):
  - UNIQUE (code)

### `dashboard_widgets`

- FKs: dashboard_id→dashboards, module_id→modules, permission_id→permissions
- Referenced by: none
- Indexes (4):
  - UNIQUE (dashboard_id, widget_key)
  - (module_id, feature_key)
  - (dashboard_id, display_order, widget_key)
  - UNIQUE (id)

### `dashboards`

- FKs: building_id→buildings, client_id→clients
- Referenced by: dashboard_widgets
- Indexes (4):
  - UNIQUE (building_id, dashboard_key) WHERE (scope_type = 'BUILDING'::text)
  - UNIQUE (client_id, dashboard_key) WHERE (scope_type = 'CLIENT'::text)
  - UNIQUE (id)
  - (workspace_key)

### `delivery_couriers`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, expected_visitor_id→expected_visitors, recipient_user_id→users, recipient_workforce_id→workforce_profiles, status_updated_by_user_id→users, visitor_id→visitors, walk_in_visit_id→walk_in_visits
- Referenced by: none
- Indexes (9):
  - (building_id, status, arrived_at)
  - (client_id, status)
  - UNIQUE (expected_visitor_id) WHERE (expected_visitor_id IS NOT NULL)
  - UNIQUE (id)
  - (recipient_user_id)
  - (recipient_workforce_id)
  - (reference_number)
  - (visitor_id, status)
  - UNIQUE (walk_in_visit_id) WHERE (walk_in_visit_id IS NOT NULL)

### `departments`

- FKs: organization_id→organizations
- Referenced by: positions, teams, workforce_profiles
- Indexes (3):
  - UNIQUE (organization_id, code)
  - (organization_id)
  - UNIQUE (id)

### `document_versions`

Immutable document versions (one per version number).

- FKs: created_by_user_id→users, document_id→documents
- Referenced by: acceptance_sign_offs, bast_submission_attempts
- Indexes (5):
  - (document_id, version_number)
  - (document_id, version_number DESC)
  - UNIQUE (document_id, version_number)
  - (expiry_date) WHERE (expiry_date IS NOT NULL)
  - UNIQUE (id)

### `documents`

Document registry (client/building scoped, expiry tracked).

- FKs: archived_by_user_id→users, building_id→buildings, client_id→clients, created_by_user_id→users
- Referenced by: bast_documents, document_versions, handover_documents, rfq_comparison_evidence_attachments, supporting_documents, work_completion_documents
- Indexes (9):
  - (client_id, archived_at) WHERE (status = 'ARCHIVED'::text)
  - (building_id, status)
  - (client_id, building_id)
  - (client_id, status)
  - UNIQUE (client_id, document_number)
  - (context_type, status)
  - (expiry_date) WHERE (expiry_date IS NOT NULL)
  - UNIQUE (id)
  - (document_type, status)

### `engineering_checklist_bindings`

- FKs: asset_id→assets, building_id→buildings, checklist_template_id→checklist_templates, client_id→clients, created_by_user_id→users, functional_location_id→functional_locations
- Referenced by: checklist_executions
- Indexes (5):
  - UNIQUE (checklist_template_id, COALESCE(asset_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(functional_location_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = 'ACTIVE'::text)
  - (asset_id, status)
  - (building_id, status)
  - UNIQUE (id)
  - (checklist_template_id, status)

### `engineering_finding_links`

- FKs: asset_id→assets, building_id→buildings, client_id→clients, created_by_user_id→users, finding_id→findings, functional_location_id→functional_locations
- Referenced by: none
- Indexes (6):
  - (asset_id)
  - (building_id)
  - UNIQUE (finding_id)
  - (finding_id)
  - UNIQUE (id)
  - UNIQUE (source_type, source_id) WHERE (source_id IS NOT NULL)

### `equipment_profiles`

- FKs: asset_id→assets
- Referenced by: permit_equipment
- Indexes (4):
  - UNIQUE (asset_id)
  - (equipment_code)
  - UNIQUE (id)
  - (status)

### `esg_baselines`

- FKs: building_id→buildings, client_id→esg_metric_definitions, client_id→clients, client_id→units_of_measure, client_id→esg_metric_definitions, client_id→units_of_measure, created_by_user_id→users, metric_definition_id→esg_metric_definitions, metric_definition_id→esg_metric_definitions, uom_id→units_of_measure, uom_id→units_of_measure, uom_id→units_of_measure
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (client_id, building_id, metric_definition_id, period_start)

### `esg_metric_definitions`

- FKs: client_id→clients, created_by_user_id→users, uom_id→units_of_measure
- Referenced by: esg_baselines, esg_metric_values, esg_targets
- Indexes (7):
  - (client_id, category, status)
  - (client_id, code)
  - UNIQUE (client_id, code)
  - (client_id, status)
  - UNIQUE (id, client_id)
  - UNIQUE (id)
  - (uom_id) WHERE (uom_id IS NOT NULL)

### `esg_metric_values`

- FKs: building_id→buildings, client_id→clients, client_id→esg_metric_definitions, client_id→esg_metric_definitions, created_by_user_id→users, metric_definition_id→esg_metric_definitions, metric_definition_id→esg_metric_definitions, uom_id→units_of_measure, verified_by_user_id→users
- Referenced by: none
- Indexes (7):
  - (building_id, period_start DESC)
  - (client_id)
  - (metric_definition_id, period_start DESC)
  - (building_id, metric_definition_id, period_type, period_start DESC)
  - UNIQUE (id)
  - UNIQUE (client_id, building_id, metric_definition_id, period_start, period_end)
  - (uom_id)

### `esg_targets`

- FKs: building_id→buildings, client_id→units_of_measure, client_id→esg_metric_definitions, client_id→clients, client_id→units_of_measure, client_id→esg_metric_definitions, created_by_user_id→users, metric_definition_id→esg_metric_definitions, metric_definition_id→esg_metric_definitions, uom_id→units_of_measure, uom_id→units_of_measure, uom_id→units_of_measure
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (client_id, building_id, metric_definition_id, period_start)

### `esg_waste_records`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, functional_location_id→functional_locations, uom_id→units_of_measure, vendor_id→vendors
- Referenced by: none
- Indexes (7):
  - (building_id, period_date DESC)
  - (building_id, waste_type, disposal_method, period_date DESC)
  - (client_id, status)
  - (functional_location_id) WHERE (functional_location_id IS NOT NULL)
  - UNIQUE (id)
  - (uom_id)
  - (vendor_id) WHERE (vendor_id IS NOT NULL)

### `evidence_requirements`

- FKs: client_id→clients
- Referenced by: evidence_submissions, permit_safety_requirements, security_incident_readiness
- Indexes (4):
  - UNIQUE (client_id, target_type, target_id, evidence_type, status)
  - (client_id, status)
  - UNIQUE (id)
  - (target_type, target_id, status)

### `evidence_retention_policies`

Per-client/building retention policies driving the retention dispatcher.

- FKs: building_id→buildings, client_id→clients
- Referenced by: evidence_submissions, report_archives
- Indexes (4):
  - (building_id, status, effective_from) WHERE (building_id IS NOT NULL)
  - (client_id, status, effective_from)
  - UNIQUE (id)
  - UNIQUE (client_id, code)

### `evidence_submissions`

Shared evidence engine submissions (retention lifecycle, execution-typed).

- FKs: client_id→clients, evidence_requirement_id→evidence_requirements, retention_hold_set_by_user_id→users, retention_policy_id→evidence_retention_policies, submitted_by_user_id→users
- Referenced by: bast_submission_attempt_evidence, utility_meter_ocr_candidates
- Indexes (7):
  - UNIQUE (execution_id) WHERE (execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'::text)
  - (client_id)
  - (execution_type, execution_id, status)
  - (execution_type, execution_id, status) WHERE (execution_type = ANY (ARRAY['FINDING'::text, 'FINDING_REWORK'::text, 'FINDING_VERIFICATION'::text]))
  - UNIQUE (id)
  - (evidence_requirement_id, status)
  - (retention_state, retained_until) WHERE (retained_until IS NOT NULL)

### `expected_visitors`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, host_user_id→users, host_workforce_id→workforce_profiles, visitor_id→visitors, visitor_invitation_id→visitor_invitations
- Referenced by: contractor_visitors, delivery_couriers, host_confirmations, visit_check_ins
- Indexes (7):
  - UNIQUE (visitor_invitation_id) WHERE ((visitor_invitation_id IS NOT NULL) AND (status = 'EXPECTED'::text))
  - (building_id, status, expected_arrival_at)
  - (client_id, status)
  - (host_user_id)
  - (host_workforce_id)
  - UNIQUE (id)
  - (visitor_id, status)

### `external_organizations`

- FKs: client_id→clients
- Referenced by: external_workforce_links
- Indexes (3):
  - (client_id)
  - UNIQUE (client_id, code)
  - UNIQUE (id)

### `external_workforce_links`

- FKs: external_organization_id→external_organizations, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (6):
  - UNIQUE (workforce_profile_id, external_organization_id) WHERE (status = 'ACTIVE'::text)
  - (external_organization_id)
  - UNIQUE (external_organization_id, external_personnel_code)
  - UNIQUE (id)
  - (status)
  - (workforce_profile_id)

### `feature_entitlement_configurations`

- FKs: building_id→buildings, client_id→clients, module_id→modules
- Referenced by: none
- Indexes (4):
  - UNIQUE (building_id, module_id, feature_key) WHERE (scope_type = 'BUILDING'::text)
  - UNIQUE (client_id, module_id, feature_key) WHERE (scope_type = 'CLIENT'::text)
  - (module_id, feature_key)
  - UNIQUE (id)

### `finding_assignments`

- FKs: assigned_by_user_id→users, finding_id→findings, team_id→teams, vendor_id→vendors, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (7):
  - UNIQUE (finding_id) WHERE (status = 'ACTIVE'::text)
  - (assigned_by_user_id, assigned_at)
  - (finding_id, status, assigned_at)
  - UNIQUE (id)
  - (team_id, status)
  - (vendor_id, status)
  - (workforce_profile_id, status)

### `finding_classifications`

- FKs: client_id→clients
- Referenced by: findings
- Indexes (3):
  - UNIQUE (client_id, code)
  - (client_id, status, code)
  - UNIQUE (id)

### `finding_escalation_incidents`

- FKs: created_by_user_id→users, finding_id→findings, incident_id→incidents
- Referenced by: none
- Indexes (6):
  - (escalated_at DESC)
  - (finding_id, escalated_at DESC)
  - UNIQUE (incident_id)
  - (incident_id)
  - UNIQUE (id)
  - (escalation_reason)

### `finding_rework_cycles`

- FKs: finding_id→findings, requested_by_user_id→users, resubmitted_by_user_id→users, review_id→reviews
- Referenced by: none
- Indexes (5):
  - UNIQUE (finding_id) WHERE (status = 'REQUESTED'::text)
  - UNIQUE (id)
  - (finding_id, requested_at)
  - (requested_by_user_id, requested_at)
  - UNIQUE (review_id)

### `finding_severities`

- FKs: client_id→clients
- Referenced by: findings
- Indexes (3):
  - (client_id, status, rank, code)
  - UNIQUE (id)
  - UNIQUE (client_id, code)

### `findings`

- FKs: building_id→buildings, classification_id→finding_classifications, client_id→clients, closed_by_user_id→users, reported_by_user_id→users, severity_id→finding_severities
- Referenced by: bast_finding_links, engineering_finding_links, finding_assignments, finding_escalation_incidents, finding_rework_cycles, housekeeping_complaint_bindings, housekeeping_finding_links, security_finding_links, tenant_complaints, utility_abnormal_consumptions
- Indexes (11):
  - UNIQUE (client_id, finding_number)
  - (building_id, status, reported_at)
  - (classification_id, status)
  - (client_id, status, reported_at)
  - (closed_at) WHERE (status = 'CLOSED'::text)
  - (closed_by_user_id) WHERE (closed_by_user_id IS NOT NULL)
  - UNIQUE (id)
  - (reported_by_user_id, reported_at)
  - (severity_id, status)
  - (source_type, source_id) WHERE (source_type IS NOT NULL)
  - (status, state_changed_at)

### `floors`

- FKs: building_id→buildings
- Referenced by: areas, cleaning_areas, handyman_arrival_location_identifiers, handyman_arrival_verification_results, handyman_execution_scopes, handyman_permit_readiness, handyman_unit_access_readiness, housekeeping_finding_links, incidents, patrol_route_points, permit_work_contexts, public_area_inspection_bindings, security_posts
- Indexes (5):
  - UNIQUE (building_id, code)
  - (building_id)
  - (building_id, level_number)
  - UNIQUE (id)
  - (status)

### `form_conditional_rules`

- FKs: source_field_id→form_template_version_fields, target_field_id→form_template_version_fields, target_section_id→form_template_version_sections, version_id→form_template_versions
- Referenced by: none
- Indexes (1):
  - UNIQUE (id)

### `form_configuration_bindings`

- FKs: building_id→buildings, client_id→clients, form_template_id→form_templates
- Referenced by: none
- Indexes (4):
  - UNIQUE (building_id, form_template_id) WHERE (scope_type = 'BUILDING'::text)
  - UNIQUE (client_id, form_template_id) WHERE (scope_type = 'CLIENT'::text)
  - UNIQUE (id)
  - (form_template_id)

### `form_fields`

- FKs: form_section_id→form_sections, uom_id→units_of_measure
- Referenced by: meter_reading_bindings
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (form_section_id, code)
  - (form_section_id, display_order)

### `form_instance_occurrences`

- FKs: form_instance_id→form_instances, repeatable_group_id→form_repeatable_groups
- Referenced by: form_responses
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (form_instance_id, repeatable_group_id, occurrence_index)
  - (form_instance_id, repeatable_group_id)

### `form_instances`

- FKs: assigned_team_id→teams, assigned_workforce_profile_id→workforce_profiles, client_id→clients, completed_by_user_id→users, form_template_version_id→form_template_versions, generated_task_id→generated_tasks, log_sheet_binding_id→log_sheet_bindings, meter_reading_binding_id→meter_reading_bindings
- Referenced by: form_instance_occurrences, form_responses, utility_meter_readings
- Indexes (7):
  - (client_id, created_at)
  - (generated_task_id)
  - UNIQUE (generated_task_id) WHERE (generated_task_id IS NOT NULL)
  - (log_sheet_binding_id)
  - (meter_reading_binding_id)
  - UNIQUE (id)
  - (form_template_version_id)

### `form_repeatable_groups`

- FKs: version_id→form_template_versions, version_section_id→form_template_version_sections
- Referenced by: form_instance_occurrences
- Indexes (2):
  - UNIQUE (id)
  - UNIQUE (version_id, version_section_id)

### `form_responses`

- FKs: form_instance_id→form_instances, last_responded_by_user_id→users, occurrence_id→form_instance_occurrences, version_field_id→form_template_version_fields
- Referenced by: none
- Indexes (3):
  - (form_instance_id)
  - UNIQUE (id)
  - UNIQUE (form_instance_id, version_field_id, COALESCE(occurrence_id, '00000000-0000-0000-0000-000000000000'::uuid))

### `form_sections`

- FKs: form_template_id→form_templates
- Referenced by: form_fields
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (form_template_id, code)
  - (form_template_id, display_order)

### `form_template_version_fields`

- FKs: version_section_id→form_template_version_sections
- Referenced by: form_conditional_rules, form_responses
- Indexes (1):
  - UNIQUE (id)

### `form_template_version_sections`

- FKs: version_id→form_template_versions
- Referenced by: form_conditional_rules, form_repeatable_groups, form_template_version_fields
- Indexes (1):
  - UNIQUE (id)

### `form_template_versions`

- FKs: form_template_id→form_templates
- Referenced by: form_conditional_rules, form_instances, form_repeatable_groups, form_template_version_sections, log_sheet_bindings
- Indexes (4):
  - UNIQUE (id)
  - (status)
  - (form_template_id, version_number)
  - UNIQUE (form_template_id, version_number)

### `form_templates`

- FKs: client_id→clients, source_form_id→source_forms
- Referenced by: form_configuration_bindings, form_sections, form_template_versions, log_sheet_bindings
- Indexes (4):
  - UNIQUE (client_id, code)
  - (client_id, status)
  - UNIQUE (id)
  - (source_form_id)

### `functional_locations`

- FKs: building_id→buildings, space_id→spaces
- Referenced by: assets, breakdown_bindings, cleaning_areas, contractor_visitors, engineering_checklist_bindings, engineering_finding_links, esg_waste_records, housekeeping_finding_links, incidents, inspection_bindings, inventory_warehouses, log_sheet_bindings, maintenance_bindings, meter_reading_bindings, patrol_route_points, permit_work_contexts, public_area_inspection_bindings, security_keys, security_lost_found, security_posts, service_requests, toilet_inspection_bindings, utility_meters, work_orders
- Indexes (5):
  - UNIQUE (building_id, code)
  - (building_id)
  - UNIQUE (id)
  - (space_id)
  - (status)

### `fx_rate_events`

- FKs: actor_user_id→users, fx_rate_id→fx_rates
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - (fx_rate_id, occurred_at DESC, id DESC)
  - (event_type, occurred_at DESC)

### `fx_rates`

- FKs: approved_by_user_id→users, base_currency_code→currencies, created_by_user_id→users, deactivated_by_user_id→users, quote_currency_code→currencies, rejected_by_user_id→users, superseded_by_rate_id→fx_rates, superseded_by_user_id→users, supersedes_rate_id→fx_rates
- Referenced by: fx_rate_events, fx_rates
- Indexes (7):
  - (base_currency_code, quote_currency_code, rate_type, tstzrange(effective_from, effective_to, '[)'::text)) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (base_currency_code, quote_currency_code, rate_type, effective_from DESC) WHERE (status = 'ACTIVE'::text)
  - (source, effective_from DESC)
  - (status, created_at DESC, id DESC)
  - UNIQUE (superseded_by_rate_id) WHERE (superseded_by_rate_id IS NOT NULL)
  - UNIQUE (supersedes_rate_id) WHERE (supersedes_rate_id IS NOT NULL)

### `generated_tasks`

- FKs: building_id→buildings, client_id→clients, completed_by_user_id→users, maintenance_binding_id→maintenance_bindings, schedule_definition_id→schedule_definitions
- Referenced by: checklist_executions, form_instances, task_assignments, utility_reading_dues
- Indexes (6):
  - (maintenance_binding_id)
  - UNIQUE (id)
  - UNIQUE (schedule_definition_id, occurrence_at)
  - (client_id, created_at)
  - (schedule_definition_id, occurrence_at)
  - (target_type, target_id)

### `handover_documents`

- FKs: bast_document_id→bast_documents, building_id→buildings, client_id→clients, document_id→documents, handed_over_by_user_id→users, prepared_by_user_id→users, vendor_work_id→vendor_works, work_completion_document_id→work_completion_documents, work_order_id→work_orders
- Referenced by: acceptance_sign_offs
- Indexes (12):
  - (bast_document_id)
  - (building_id, handover_status)
  - (client_id, handover_status)
  - UNIQUE (client_id, handover_number)
  - (context_type, handover_status)
  - UNIQUE (document_id)
  - (document_id)
  - UNIQUE (id)
  - (vendor_work_id, handover_status)
  - UNIQUE (vendor_work_id) WHERE (vendor_work_id IS NOT NULL)
  - (work_completion_document_id)
  - (work_order_id, handover_status)

### `handyman_arrival_challenges`

- FKs: actor_user_id→users, assignment_id→handyman_execution_scope_assignments, client_id→clients, execution_scope_id→handyman_execution_scopes
- Referenced by: handyman_arrival_verification_results
- Indexes (3):
  - UNIQUE (execution_scope_id, actor_user_id) WHERE (status = 'PENDING'::text)
  - UNIQUE (id)
  - (execution_scope_id, created_at)

### `handyman_arrival_location_identifiers`

- FKs: area_id→areas, building_id→buildings, client_id→clients, floor_id→floors, room_id→rooms, space_id→spaces
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - (client_id, status)
  - UNIQUE (opaque_code_hash)

### `handyman_arrival_verification_results`

Arrival verification results (QR + geofence evidence, status/reason pairs).

- FKs: actor_user_id→users, assignment_id→handyman_execution_scope_assignments, challenge_id→handyman_arrival_challenges, client_id→clients, execution_scope_id→handyman_execution_scopes, expected_area_id→areas, expected_building_id→buildings, expected_floor_id→floors, expected_room_id→rooms, expected_space_id→spaces, geospatial_policy_id→handyman_building_geospatial_policies
- Referenced by: none
- Indexes (3):
  - UNIQUE (challenge_id)
  - (execution_scope_id, created_at)
  - UNIQUE (id)

### `handyman_bast_documents`

BAST (handover) documents per execution scope (one non-VOID per scope).

- FKs: client_id→clients, execution_scope_id→handyman_execution_scopes
- Referenced by: handyman_bast_events, handyman_bast_sign_offs, handyman_chargeable_additional_works, handyman_service_warranties, handyman_service_warranty_claims, handyman_service_warranty_events, handyman_service_warranty_reworks
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (execution_scope_id) WHERE (status <> 'VOID'::text)
  - (execution_scope_id, created_at)

### `handyman_bast_events`

- FKs: actor_user_id→users, bast_id→handyman_bast_documents, client_id→clients, execution_scope_id→handyman_execution_scopes
- Referenced by: handyman_bast_sign_offs
- Indexes (3):
  - (bast_id, occurred_at)
  - UNIQUE (bast_id, event_type, idempotency_key)
  - UNIQUE (id)

### `handyman_bast_sign_offs`

- FKs: bast_id→handyman_bast_documents, client_id→clients, event_id→handyman_bast_events, evidence_record_id→handyman_evidence_records, execution_scope_id→handyman_execution_scopes
- Referenced by: none
- Indexes (3):
  - (bast_id, created_at)
  - UNIQUE (event_id)
  - UNIQUE (id)

### `handyman_bm_fee_beneficiary_definitions`

- FKs: agreement_version_id→handyman_commercial_agreement_versions, beneficiary_reference_id→clients, created_by_user_id→users
- Referenced by: handyman_entitlement_facts
- Indexes (4):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - (agreement_version_id, created_at, id)
  - UNIQUE (agreement_version_id)

### `handyman_bm_fee_rule_definitions`

- FKs: agreement_version_id→handyman_commercial_agreement_versions, created_by_user_id→users
- Referenced by: handyman_entitlement_facts
- Indexes (3):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - UNIQUE (agreement_version_id)

### `handyman_bm_fee_term_definitions`

- FKs: agreement_version_id→handyman_commercial_agreement_versions, created_by_user_id→users
- Referenced by: handyman_entitlement_facts
- Indexes (4):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - (agreement_version_id, created_at, id)
  - UNIQUE (agreement_version_id)

### `handyman_building_geospatial_policies`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users
- Referenced by: handyman_arrival_verification_results
- Indexes (3):
  - (building_id, created_at)
  - UNIQUE (building_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)

### `handyman_care_property_grants`

- FKs: care_actor_id→handyman_handoff_care_actors, granted_by_user_id→users, property_id→properties, revoked_by_user_id→users
- Referenced by: none
- Indexes (3):
  - UNIQUE (care_actor_id, property_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (property_id, status)

### `handyman_care_workspace_sessions`

- FKs: care_actor_id→handyman_handoff_care_actors, integration_id→handyman_handoff_integrations
- Referenced by: handyman_handoff_exchanges
- Indexes (5):
  - (care_actor_id)
  - UNIQUE (integration_id, assertion_id)
  - (integration_id)
  - UNIQUE (id)
  - UNIQUE (token_hash)

### `handyman_channel_attributions`

- FKs: building_id→buildings, care_actor_id→handyman_handoff_care_actors, client_id→clients, created_by_user_id→users, space_id→spaces, tenant_company_id→tenant_companies, tenant_pic_id→tenant_pics
- Referenced by: handyman_execution_scopes, handyman_request_diagnoses, handyman_request_inspections, handyman_request_referrals, handyman_request_triage_decisions, handyman_service_requests
- Indexes (4):
  - (client_id)
  - UNIQUE (origin_channel, origin_reference) WHERE (origin_reference IS NOT NULL)
  - UNIQUE (id)
  - (tenant_company_id, building_id)

### `handyman_charge_line_bases`

- FKs: actor_user_id→users, agreement_id→handyman_commercial_agreements, agreement_version_id→handyman_commercial_agreement_versions, charge_line_id→handyman_charge_lines, client_id→clients, labor_basis_row_id→handyman_labor_pricing_basis_definitions, material_basis_row_id→handyman_material_pricing_basis_definitions, quotation_line_id→handyman_quotation_lines, quotation_version_id→handyman_quotation_versions, transaction_id→handyman_customer_transactions
- Referenced by: none
- Indexes (3):
  - UNIQUE (charge_line_id)
  - UNIQUE (id)
  - (transaction_id, created_at, id)

### `handyman_charge_lines`

Charge composition lines per transaction (quotation-line-bound).

- FKs: client_id→handyman_customer_transactions, client_id→clients, client_id→handyman_customer_transactions, created_by_user_id→users, currency→handyman_customer_transactions, currency→handyman_customer_transactions, quotation_line_id→handyman_quotation_lines, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions
- Referenced by: handyman_charge_line_bases, handyman_customer_transaction_events, handyman_ledger_corrections, handyman_payment_allocations, tenant_invoice_lines
- Indexes (4):
  - UNIQUE (id, transaction_id)
  - UNIQUE (id)
  - UNIQUE (transaction_id, quotation_line_id)
  - (transaction_id, created_at, id)

### `handyman_chargeable_additional_work_events`

- FKs: actor_user_id→users, bast_id→handyman_chargeable_additional_works, bast_id→handyman_chargeable_additional_works, claim_id→handyman_chargeable_additional_works, claim_id→handyman_chargeable_additional_works, client_id→clients, client_id→handyman_chargeable_additional_works, client_id→handyman_chargeable_additional_works, execution_scope_id→handyman_chargeable_additional_works, execution_scope_id→handyman_chargeable_additional_works, warranty_id→handyman_chargeable_additional_works, warranty_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works, work_id→handyman_chargeable_additional_works
- Referenced by: none
- Indexes (3):
  - UNIQUE (work_id, event_type, idempotency_key)
  - UNIQUE (id)
  - (work_id, occurred_at, id)

### `handyman_chargeable_additional_works`

Chargeable additional work per claim.

- FKs: bast_id→handyman_service_warranties, bast_id→handyman_bast_documents, bast_id→handyman_service_warranty_claims, bast_id→handyman_service_warranty_claims, bast_id→handyman_service_warranties, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, client_id→handyman_service_warranty_claims, client_id→handyman_service_warranty_claims, client_id→clients, client_id→handyman_service_warranties, client_id→handyman_service_warranties, decided_by_user_id→users, execution_scope_id→handyman_service_warranty_claims, execution_scope_id→handyman_service_warranty_claims, execution_scope_id→handyman_execution_scopes, proposed_by_user_id→users, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranty_claims, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranty_claims, warranty_id→handyman_service_warranties
- Referenced by: handyman_chargeable_additional_work_events
- Indexes (9):
  - UNIQUE (claim_id)
  - UNIQUE (id, bast_id)
  - UNIQUE (id, claim_id)
  - UNIQUE (id, client_id)
  - UNIQUE (id, execution_scope_id)
  - UNIQUE (id, warranty_id)
  - UNIQUE (id)
  - (execution_scope_id, status, created_at)
  - (warranty_id, created_at, id)

### `handyman_commercial_agreement_events`

- FKs: actor_user_id→users, agreement_id→handyman_commercial_agreements, client_id→clients, version_id→handyman_commercial_agreement_versions
- Referenced by: none
- Indexes (3):
  - (agreement_id, occurred_at)
  - UNIQUE (agreement_id, event_type, idempotency_key)
  - UNIQUE (id)

### `handyman_commercial_agreement_versions`

- FKs: agreement_id→handyman_commercial_agreements, created_by_user_id→users
- Referenced by: handyman_bm_fee_beneficiary_definitions, handyman_bm_fee_rule_definitions, handyman_bm_fee_term_definitions, handyman_charge_line_bases, handyman_commercial_agreement_events, handyman_entitlement_facts, handyman_labor_pricing_basis_definitions, handyman_material_pricing_basis_definitions
- Indexes (4):
  - UNIQUE (agreement_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (agreement_id, version_number)
  - UNIQUE (id)
  - (agreement_id, effective_from)

### `handyman_commercial_agreements`

- FKs: client_id→clients, created_by_user_id→users
- Referenced by: handyman_charge_line_bases, handyman_commercial_agreement_events, handyman_commercial_agreement_versions, handyman_entitlement_facts
- Indexes (2):
  - UNIQUE (client_id)
  - UNIQUE (id)

### `handyman_common_material_profiles`

- FKs: client_id→service_catalog, client_id→service_catalog, client_id→handyman_service_variants, client_id→handyman_service_variants, client_id→clients, created_by_user_id→users, inventory_item_id→inventory_items, service_catalog_id→service_catalog, service_catalog_id→service_catalog, service_variant_id→handyman_service_variants, service_variant_id→handyman_service_variants
- Referenced by: none
- Indexes (8):
  - (client_id, status)
  - UNIQUE (id, client_id)
  - (inventory_item_id)
  - UNIQUE (id)
  - (service_catalog_id, status)
  - UNIQUE (service_catalog_id, inventory_item_id) WHERE (service_variant_id IS NULL)
  - (service_variant_id)
  - UNIQUE (service_variant_id, inventory_item_id) WHERE (service_variant_id IS NOT NULL)

### `handyman_crew_leads`

- FKs: client_id→clients, designated_by_user_id→users, handyman_crew_id→handyman_work_crews, handyman_crew_membership_id→handyman_crew_memberships
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - (client_id, designated_at)
  - UNIQUE (handyman_crew_id, lead_seq)

### `handyman_crew_memberships`

- FKs: client_id→clients, created_by_user_id→users, handyman_crew_id→handyman_work_crews, handyman_worker_context_id→handyman_worker_contexts
- Referenced by: handyman_crew_leads
- Indexes (3):
  - UNIQUE (handyman_crew_id, handyman_worker_context_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (client_id, created_at)

### `handyman_customer_payment_events`

- FKs: actor_user_id→users, client_id→clients, payment_id→handyman_customer_payments
- Referenced by: none
- Indexes (3):
  - UNIQUE (transaction_id, event_type, idempotency_key)
  - UNIQUE (id)
  - (transaction_id, occurred_at, id)

### `handyman_customer_payments`

Customer payment claims/events per transaction (external_reference idempotency).

- FKs: client_id→handyman_customer_transactions, client_id→handyman_customer_transactions, client_id→clients, currency→handyman_customer_transactions, currency→handyman_customer_transactions, decided_by_user_id→users, recorded_by_user_id→users, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions
- Referenced by: handyman_customer_payment_events, handyman_ledger_corrections, handyman_payment_allocations
- Indexes (4):
  - UNIQUE (transaction_id, external_reference) WHERE (external_reference IS NOT NULL)
  - UNIQUE (id, transaction_id)
  - UNIQUE (id)
  - (transaction_id, received_at, id)

### `handyman_customer_transaction_events`

- FKs: actor_user_id→users, charge_line_id→handyman_charge_lines, client_id→clients, transaction_id→handyman_customer_transactions
- Referenced by: none
- Indexes (3):
  - UNIQUE (transaction_id, event_type, idempotency_key)
  - UNIQUE (id)
  - (transaction_id, occurred_at, id)

### `handyman_customer_transactions`

Customer ledger transaction (one per execution scope; currency-bound).

- FKs: client_id→clients, created_by_user_id→users, execution_scope_id→handyman_execution_scopes, quotation_version_id→handyman_quotation_versions
- Referenced by: handyman_charge_line_bases, handyman_charge_lines, handyman_customer_payments, handyman_customer_transaction_events, handyman_entitlement_facts, handyman_ledger_corrections, handyman_payment_allocations, handyman_settlement_units
- Indexes (5):
  - (client_id, created_at, id)
  - UNIQUE (id, client_id)
  - UNIQUE (id, currency)
  - UNIQUE (id)
  - UNIQUE (execution_scope_id)

### `handyman_defect_events`

- FKs: actor_user_id→users, client_id→clients, defect_id→handyman_defect_records
- Referenced by: none
- Indexes (3):
  - (defect_id, occurred_at, id)
  - UNIQUE (defect_id, event_type, idempotency_key)
  - UNIQUE (id)

### `handyman_defect_records`

Defect records raised by QC per execution scope.

- FKs: client_id→clients, execution_scope_id→handyman_execution_scopes, item_id→handyman_qc_run_items, run_id→handyman_qc_runs
- Referenced by: handyman_defect_events
- Indexes (2):
  - UNIQUE (id)
  - (execution_scope_id, created_at, id)

### `handyman_discipline_service_associations`

- FKs: client_id→clients, created_by_user_id→users, handyman_discipline_id→handyman_disciplines, service_catalog_id→service_catalog
- Referenced by: none
- Indexes (3):
  - UNIQUE (service_catalog_id)
  - UNIQUE (id)
  - (client_id, created_at)

### `handyman_disciplines`

- FKs: none
- Referenced by: handyman_discipline_service_associations, handyman_request_diagnoses, handyman_request_referrals
- Indexes (2):
  - UNIQUE (code)
  - UNIQUE (id)

### `handyman_entitlement_corrections`

- FKs: actor_user_id→users, entitlement_id→handyman_entitlement_facts
- Referenced by: none
- Indexes (4):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - UNIQUE (entitlement_id, ledger_correction_id)
  - UNIQUE (entitlement_id) WHERE (fact_kind = 'REVERSED'::text)

### `handyman_entitlement_facts`

- FKs: agreement_id→handyman_commercial_agreements, agreement_version_id→handyman_commercial_agreement_versions, assignment_id→handyman_execution_scope_assignments, bm_beneficiary_id→handyman_bm_fee_beneficiary_definitions, bm_beneficiary_reference_id→clients, bm_rule_id→handyman_bm_fee_rule_definitions, bm_term_id→handyman_bm_fee_term_definitions, client_id→clients, client_id→handyman_customer_transactions, client_id→handyman_customer_transactions, crew_id→handyman_work_crews, currency→handyman_customer_transactions, currency→handyman_customer_transactions, derived_by_user_id→users, execution_scope_id→handyman_execution_scopes, lead_user_id→users, lead_worker_id→handyman_worker_contexts, provider_context_id→handyman_provider_contexts, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions
- Referenced by: handyman_entitlement_corrections, handyman_settlement_inclusions
- Indexes (4):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - (client_id, derived_at, id)
  - UNIQUE (transaction_id, entitlement_kind)

### `handyman_evidence_record_events`

- FKs: actor_user_id→users, client_id→clients, record_id→handyman_evidence_records
- Referenced by: none
- Indexes (3):
  - UNIQUE (record_id, event_type, idempotency_key)
  - (record_id, occurred_at, id)
  - UNIQUE (id)

### `handyman_evidence_record_files`

Files attached to Handyman evidence records.

- FKs: record_id→handyman_evidence_records
- Referenced by: none
- Indexes (3):
  - (record_id, created_at, id)
  - UNIQUE (id)
  - UNIQUE (storage_key)

### `handyman_evidence_records`

Handyman evidence record registry (scope/stage keyed).

- FKs: client_id→clients, execution_scope_id→handyman_execution_scopes, session_id→handyman_work_sessions
- Referenced by: handyman_bast_sign_offs, handyman_evidence_record_events, handyman_evidence_record_files, handyman_service_warranty_claims, handyman_service_warranty_reworks
- Indexes (2):
  - UNIQUE (id)
  - (execution_scope_id, stage, created_at, id)

### `handyman_execution_scope_assignments`

Provider/crew assignment per execution scope (one ACTIVE per scope).

- FKs: assigned_by_user_id→users, client_id→clients, execution_scope_id→handyman_execution_scopes, handyman_crew_id→handyman_work_crews, handyman_provider_context_id→handyman_provider_contexts, supersedes_assignment_id→handyman_execution_scope_assignments
- Referenced by: handyman_arrival_challenges, handyman_arrival_verification_results, handyman_entitlement_facts, handyman_execution_scope_assignments, handyman_work_sessions
- Indexes (3):
  - (client_id, assigned_at)
  - UNIQUE (execution_scope_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)

### `handyman_execution_scopes`

- FKs: approved_quotation_version_id→handyman_quotation_versions, area_id→areas, building_id→buildings, channel_attribution_id→handyman_channel_attributions, client_id→handyman_service_requests, client_id→handyman_service_requests, client_id→clients, created_by_user_id→users, floor_id→floors, handyman_request_id→handyman_service_requests, handyman_request_id→handyman_service_requests, quotation_decision_id→handyman_quotation_decisions, quotation_id→handyman_quotations, room_id→rooms, space_id→spaces, tenant_company_id→tenant_companies, tenant_pic_id→tenant_pics
- Referenced by: handyman_arrival_challenges, handyman_arrival_verification_results, handyman_bast_documents, handyman_bast_events, handyman_bast_sign_offs, handyman_chargeable_additional_works, handyman_customer_transactions, handyman_defect_records, handyman_entitlement_facts, handyman_evidence_records, handyman_execution_scope_assignments, handyman_material_execution_events, handyman_material_execution_lines, handyman_qc_runs, handyman_service_warranties, handyman_service_warranty_claims, handyman_service_warranty_coverages, handyman_service_warranty_events, handyman_service_warranty_reworks, handyman_settlement_units, handyman_visit_appointments, handyman_work_session_events, handyman_work_session_helper_presence, handyman_work_sessions, tenant_invoices
- Indexes (3):
  - UNIQUE (id)
  - (client_id, handyman_request_id)
  - UNIQUE (approved_quotation_version_id)

### `handyman_handoff_assertions`

- FKs: integration_id→handyman_handoff_integrations
- Referenced by: handyman_handoff_exchanges
- Indexes (3):
  - (integration_id, created_at)
  - UNIQUE (id)
  - UNIQUE (integration_id, assertion_id)

### `handyman_handoff_care_actors`

- FKs: integration_id→handyman_handoff_integrations
- Referenced by: handyman_care_property_grants, handyman_care_workspace_sessions, handyman_channel_attributions, handyman_handoff_exchanges
- Indexes (3):
  - (integration_id, status)
  - UNIQUE (id)
  - UNIQUE (integration_id, actor_reference)

### `handyman_handoff_exchanges`

- FKs: building_id→buildings, care_actor_id→handyman_handoff_care_actors, care_property_id→properties, client_id→clients, handoff_assertion_id→handyman_handoff_assertions, integration_id→handyman_handoff_integrations, resolved_user_id→users, space_id→spaces, tenant_building_context_id→tenant_building_contexts, tenant_company_id→tenant_companies, tenant_pic_id→tenant_pics, tenant_space_relationship_id→tenant_space_relationships, workspace_session_id→handyman_care_workspace_sessions
- Referenced by: none
- Indexes (4):
  - (client_id, status)
  - (expires_at)
  - UNIQUE (id)
  - UNIQUE (token_hash)

### `handyman_handoff_integrations`

- FKs: none
- Referenced by: handyman_care_workspace_sessions, handyman_handoff_assertions, handyman_handoff_care_actors, handyman_handoff_exchanges
- Indexes (2):
  - UNIQUE (integration_code)
  - UNIQUE (id)

### `handyman_labor_pricing_basis_definitions`

- FKs: agreement_version_id→handyman_commercial_agreement_versions, created_by_user_id→users
- Referenced by: handyman_charge_line_bases
- Indexes (4):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - (agreement_version_id, created_at, id)
  - UNIQUE (agreement_version_id, mode)

### `handyman_ledger_corrections`

Governed ledger corrections (append-only).

- FKs: client_id→clients, client_id→handyman_customer_transactions, client_id→handyman_customer_transactions, corrected_by_user_id→users, currency→handyman_customer_transactions, currency→handyman_customer_transactions, source_allocation_id→handyman_payment_allocations, source_allocation_id→handyman_payment_allocations, source_charge_line_id→handyman_charge_lines, source_charge_line_id→handyman_charge_lines, source_payment_id→handyman_customer_payments, source_payment_id→handyman_customer_payments, transaction_id→handyman_payment_allocations, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_payments, transaction_id→handyman_customer_payments, transaction_id→handyman_charge_lines, transaction_id→handyman_charge_lines, transaction_id→handyman_payment_allocations
- Referenced by: none
- Indexes (6):
  - UNIQUE (transaction_id, idempotency_key)
  - (source_payment_id) WHERE (source_payment_id IS NOT NULL)
  - UNIQUE (id)
  - UNIQUE (source_allocation_id) WHERE ((correction_kind = 'REVERSAL'::text) AND (source_allocation_id IS NOT NULL))
  - UNIQUE (source_payment_id) WHERE ((correction_kind = 'REVERSAL'::text) AND (source_payment_id IS NOT NULL))
  - (transaction_id, occurred_at, id)

### `handyman_material_execution_events`

- FKs: actor_user_id→users, client_id→clients, execution_scope_id→handyman_execution_scopes, line_id→handyman_material_execution_lines
- Referenced by: none
- Indexes (3):
  - UNIQUE (line_id, event_type, idempotency_key)
  - (line_id, occurred_at, id)
  - UNIQUE (id)

### `handyman_material_execution_lines`

Material execution lines settled against quotation lines.

- FKs: client_id→clients, execution_scope_id→handyman_execution_scopes, quotation_line_id→handyman_quotation_lines, quotation_version_id→handyman_quotation_versions, source_item_id→inventory_items
- Referenced by: handyman_material_execution_events
- Indexes (3):
  - (quotation_version_id, quotation_line_id)
  - (execution_scope_id, created_at, id)
  - UNIQUE (id)

### `handyman_material_pricing_basis_definitions`

- FKs: agreement_version_id→handyman_commercial_agreement_versions, created_by_user_id→users
- Referenced by: handyman_charge_line_bases
- Indexes (3):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - UNIQUE (agreement_version_id)

### `handyman_payment_allocations`

Payment allocations to charge lines (idempotency-keyed).

- FKs: allocated_by_user_id→users, charge_line_id→handyman_charge_lines, charge_line_id→handyman_charge_lines, client_id→handyman_customer_transactions, client_id→clients, client_id→handyman_customer_transactions, currency→handyman_customer_transactions, currency→handyman_customer_transactions, payment_id→handyman_customer_payments, payment_id→handyman_customer_payments, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_payments, transaction_id→handyman_customer_payments, transaction_id→handyman_customer_transactions, transaction_id→handyman_charge_lines, transaction_id→handyman_customer_transactions, transaction_id→handyman_charge_lines, transaction_id→handyman_customer_transactions
- Referenced by: handyman_ledger_corrections
- Indexes (6):
  - (charge_line_id, occurred_at, id)
  - UNIQUE (id, transaction_id)
  - UNIQUE (transaction_id, idempotency_key)
  - (payment_id, occurred_at, id)
  - UNIQUE (id)
  - (transaction_id, occurred_at, id)

### `handyman_permit_readiness`

Readiness stage: permit readiness rows (one ACTIVE per request).

- FKs: area_id→areas, authorized_by_user_id→users, building_id→buildings, client_id→clients, floor_id→floors, handyman_request_id→handyman_service_requests, room_id→rooms, space_id→spaces, supersedes_readiness_id→handyman_permit_readiness
- Referenced by: handyman_permit_readiness
- Indexes (3):
  - UNIQUE (handyman_request_id) WHERE (status = 'ACTIVE'::text)
  - (client_id, created_at)
  - UNIQUE (id)

### `handyman_provider_contexts`

- FKs: client_id→clients, created_by_user_id→users, vendor_id→vendors
- Referenced by: handyman_entitlement_facts, handyman_execution_scope_assignments, handyman_work_crews, handyman_worker_contexts
- Indexes (3):
  - UNIQUE (id)
  - (client_id, created_at)
  - UNIQUE (vendor_id)

### `handyman_qc_run_events`

- FKs: actor_user_id→users, client_id→clients, run_id→handyman_qc_runs
- Referenced by: none
- Indexes (3):
  - UNIQUE (run_id, event_type, idempotency_key)
  - UNIQUE (id)
  - (run_id, occurred_at, id)

### `handyman_qc_run_items`

- FKs: run_id→handyman_qc_runs
- Referenced by: handyman_defect_records
- Indexes (3):
  - UNIQUE (id)
  - (run_id, created_at, id)
  - UNIQUE (run_id, item_key)

### `handyman_qc_runs`

QC runs per execution scope (one OPEN per scope).

- FKs: client_id→clients, execution_scope_id→handyman_execution_scopes, session_id→handyman_work_sessions
- Referenced by: handyman_defect_records, handyman_qc_run_events, handyman_qc_run_items, handyman_service_warranty_reworks
- Indexes (3):
  - UNIQUE (execution_scope_id) WHERE (status = 'OPEN'::text)
  - UNIQUE (id)
  - (execution_scope_id, created_at, id)

### `handyman_quotation_decisions`

- FKs: client_id→clients, decided_by_user_id→users, quotation_id→handyman_quotations, quotation_version_id→handyman_quotation_versions, tenant_company_id→tenant_companies, tenant_pic_id→tenant_pics
- Referenced by: handyman_execution_scopes
- Indexes (4):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - (client_id, quotation_id, decided_at)
  - UNIQUE (quotation_version_id)

### `handyman_quotation_lines`

Quotation line items (labor/material pricing composition).

- FKs: created_by_user_id→users, quotation_version_id→handyman_quotation_versions, source_item_id→inventory_items, uom_id→units_of_measure
- Referenced by: handyman_charge_line_bases, handyman_charge_lines, handyman_material_execution_lines
- Indexes (2):
  - UNIQUE (id)
  - (quotation_version_id, created_at, id)

### `handyman_quotation_versions`

Quotation versions (one ISSUED per quotation); pricing snapshot.

- FKs: created_by_user_id→users, quotation_id→handyman_quotations
- Referenced by: handyman_charge_line_bases, handyman_customer_transactions, handyman_execution_scopes, handyman_material_execution_lines, handyman_quotation_decisions, handyman_quotation_lines
- Indexes (4):
  - UNIQUE (quotation_id) WHERE (status = 'ISSUED'::text)
  - UNIQUE (quotation_id, version_number)
  - UNIQUE (id)
  - (quotation_id, version_number)

### `handyman_quotations`

One quotation per Handyman request; versioned issuance/decision.

- FKs: client_id→handyman_service_requests, client_id→handyman_service_requests, client_id→clients, created_by_user_id→users, handyman_request_id→handyman_service_requests, handyman_request_id→handyman_service_requests
- Referenced by: handyman_execution_scopes, handyman_quotation_decisions, handyman_quotation_versions
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (handyman_request_id)
  - (client_id, created_at)

### `handyman_request_diagnoses`

Frozen F2 diagnosis per Handyman request (one row per request).

- FKs: building_id→buildings, channel_attribution_id→handyman_channel_attributions, client_id→handyman_service_requests, client_id→handyman_service_requests, client_id→clients, diagnosed_by_user_id→users, handyman_discipline_id→handyman_disciplines, handyman_request_id→handyman_service_requests, handyman_request_id→handyman_service_requests, recommended_service_catalog_id→service_catalog
- Referenced by: handyman_request_referrals
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (handyman_request_id)
  - (client_id, diagnosed_at)

### `handyman_request_inspections`

Frozen F2 inspection record per Handyman request (append-only, trigger-guarded).

- FKs: building_id→buildings, channel_attribution_id→handyman_channel_attributions, client_id→handyman_service_requests, client_id→handyman_service_requests, client_id→clients, handyman_request_id→handyman_service_requests, handyman_request_id→handyman_service_requests, inspected_by_user_id→users
- Referenced by: none
- Indexes (3):
  - UNIQUE (handyman_request_id)
  - (client_id, inspected_at)
  - UNIQUE (id)

### `handyman_request_referrals`

Frozen F3 referral per Handyman request (one row per request).

- FKs: building_id→buildings, channel_attribution_id→handyman_channel_attributions, client_id→handyman_service_requests, client_id→handyman_service_requests, client_id→clients, handyman_diagnosis_id→handyman_request_diagnoses, handyman_discipline_id→handyman_disciplines, handyman_request_id→handyman_service_requests, handyman_request_id→handyman_service_requests, referred_by_user_id→users
- Referenced by: none
- Indexes (4):
  - UNIQUE (handyman_diagnosis_id)
  - UNIQUE (id)
  - UNIQUE (handyman_request_id)
  - (client_id, referred_at)

### `handyman_request_triage_decisions`

Frozen F1 triage decision per Handyman request (one row per request).

- FKs: actor_user_id→users, building_id→buildings, channel_attribution_id→handyman_channel_attributions, client_id→handyman_service_requests, client_id→handyman_service_requests, client_id→clients, handyman_request_id→handyman_service_requests, handyman_request_id→handyman_service_requests
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (handyman_request_id)
  - (client_id, created_at)

### `handyman_scheduling_readiness`

Readiness stage: scheduling readiness rows (one ACTIVE per request).

- FKs: client_id→clients, created_by_user_id→users, handyman_request_id→handyman_service_requests, supersedes_readiness_id→handyman_scheduling_readiness
- Referenced by: handyman_scheduling_readiness
- Indexes (3):
  - UNIQUE (handyman_request_id) WHERE (status = 'ACTIVE'::text)
  - (client_id, created_at)
  - UNIQUE (id)

### `handyman_service_requests`

Authoritative Handyman customer request lifecycle (intake→triage→diagnosis→referral). No authoritative WorkOrder relation.

- FKs: building_id→buildings, channel_attribution_id→handyman_channel_attributions, client_id→handyman_service_variants, client_id→handyman_service_variants, client_id→service_catalog, client_id→service_catalog, client_id→clients, created_by_user_id→users, service_catalog_id→service_catalog, service_catalog_id→service_catalog, service_variant_id→handyman_service_variants, service_variant_id→handyman_service_variants, space_id→spaces, tenant_company_id→tenant_companies, tenant_pic_id→tenant_pics
- Referenced by: handyman_execution_scopes, handyman_permit_readiness, handyman_quotations, handyman_request_diagnoses, handyman_request_inspections, handyman_request_referrals, handyman_request_triage_decisions, handyman_scheduling_readiness, handyman_unit_access_readiness, handyman_visit_appointments
- Indexes (7):
  - (channel_attribution_id)
  - (building_id, status)
  - UNIQUE (channel_attribution_id)
  - (client_id, status)
  - UNIQUE (id, client_id)
  - UNIQUE (id)
  - (service_catalog_id, status)

### `handyman_service_variants`

- FKs: client_id→clients, client_id→service_catalog, client_id→service_catalog, created_by_user_id→users, service_catalog_id→service_catalog, service_catalog_id→service_catalog
- Referenced by: handyman_common_material_profiles, handyman_service_requests
- Indexes (5):
  - (client_id, status)
  - UNIQUE (id, client_id)
  - UNIQUE (id)
  - UNIQUE (service_catalog_id, code)
  - (service_catalog_id, status)

### `handyman_service_warranties`

Service warranty per BAST (one per execution scope).

- FKs: bast_id→handyman_bast_documents, client_id→clients, execution_scope_id→handyman_execution_scopes, started_by_user_id→users
- Referenced by: handyman_chargeable_additional_works, handyman_service_warranty_claims, handyman_service_warranty_coverages, handyman_service_warranty_events, handyman_service_warranty_reworks
- Indexes (6):
  - (client_id, status, created_at)
  - UNIQUE (id)
  - UNIQUE (bast_id)
  - UNIQUE (id, bast_id)
  - UNIQUE (id, client_id)
  - UNIQUE (execution_scope_id)

### `handyman_service_warranty_claim_events`

- FKs: actor_user_id→users, bast_id→handyman_service_warranty_claims, bast_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, client_id→clients, client_id→handyman_service_warranty_claims, client_id→handyman_service_warranty_claims, execution_scope_id→handyman_service_warranty_claims, execution_scope_id→handyman_service_warranty_claims, warranty_id→handyman_service_warranty_claims, warranty_id→handyman_service_warranty_claims
- Referenced by: none
- Indexes (3):
  - (claim_id, occurred_at, id)
  - UNIQUE (claim_id, event_type, idempotency_key)
  - UNIQUE (id)

### `handyman_service_warranty_claims`

Warranty claims per scope (open-claim uniqueness per warranty).

- FKs: bast_id→handyman_bast_documents, bast_id→handyman_service_warranties, bast_id→handyman_service_warranties, claimant_user_id→users, client_id→handyman_service_warranties, client_id→clients, client_id→handyman_service_warranties, decided_by_user_id→users, evidence_record_id→handyman_evidence_records, execution_scope_id→handyman_execution_scopes, opened_by_user_id→users, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties
- Referenced by: handyman_chargeable_additional_works, handyman_service_warranty_claim_events, handyman_service_warranty_reworks
- Indexes (8):
  - UNIQUE (id, bast_id)
  - UNIQUE (id, client_id)
  - UNIQUE (id, execution_scope_id)
  - UNIQUE (id, warranty_id)
  - (client_id, status, created_at)
  - UNIQUE (warranty_id) WHERE (status = ANY (ARRAY['CLAIM_DRAFT'::text, 'CLAIM_SUBMITTED'::text]))
  - UNIQUE (id)
  - (warranty_id, created_at, id)

### `handyman_service_warranty_coverages`

- FKs: client_id→handyman_service_warranties, client_id→clients, client_id→handyman_service_warranties, execution_scope_id→handyman_execution_scopes, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties
- Referenced by: none
- Indexes (3):
  - UNIQUE (warranty_id, coverage_type)
  - UNIQUE (id)
  - (execution_scope_id, coverage_type)

### `handyman_service_warranty_events`

- FKs: actor_user_id→users, bast_id→handyman_service_warranties, bast_id→handyman_bast_documents, bast_id→handyman_service_warranties, client_id→clients, client_id→handyman_service_warranties, client_id→handyman_service_warranties, execution_scope_id→handyman_execution_scopes, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties
- Referenced by: none
- Indexes (3):
  - UNIQUE (warranty_id, event_type, idempotency_key)
  - UNIQUE (id)
  - (warranty_id, occurred_at)

### `handyman_service_warranty_rework_events`

- FKs: actor_user_id→users, bast_id→handyman_service_warranty_reworks, bast_id→handyman_service_warranty_reworks, claim_id→handyman_service_warranty_reworks, claim_id→handyman_service_warranty_reworks, client_id→handyman_service_warranty_reworks, client_id→clients, client_id→handyman_service_warranty_reworks, execution_scope_id→handyman_service_warranty_reworks, execution_scope_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, rework_id→handyman_service_warranty_reworks, warranty_id→handyman_service_warranty_reworks, warranty_id→handyman_service_warranty_reworks
- Referenced by: none
- Indexes (3):
  - UNIQUE (rework_id, event_type, idempotency_key)
  - UNIQUE (id)
  - (rework_id, occurred_at, id)

### `handyman_service_warranty_reworks`

Warranty rework cycles per claim.

- FKs: authorized_by_user_id→users, bast_id→handyman_service_warranties, bast_id→handyman_service_warranty_claims, bast_id→handyman_service_warranty_claims, bast_id→handyman_bast_documents, bast_id→handyman_service_warranties, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, claim_id→handyman_service_warranty_claims, client_id→handyman_service_warranty_claims, client_id→clients, client_id→handyman_service_warranties, client_id→handyman_service_warranties, client_id→handyman_service_warranty_claims, execution_scope_id→handyman_execution_scopes, execution_scope_id→handyman_service_warranty_claims, execution_scope_id→handyman_service_warranty_claims, proposed_by_user_id→users, verification_evidence_record_id→handyman_evidence_records, verification_qc_run_id→handyman_qc_runs, verified_by_user_id→users, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranties, warranty_id→handyman_service_warranty_claims, warranty_id→handyman_service_warranty_claims, warranty_id→handyman_service_warranties
- Referenced by: handyman_service_warranty_rework_events
- Indexes (9):
  - UNIQUE (claim_id)
  - UNIQUE (id, bast_id)
  - UNIQUE (id, claim_id)
  - UNIQUE (id, client_id)
  - UNIQUE (id, execution_scope_id)
  - UNIQUE (id, warranty_id)
  - UNIQUE (id)
  - (execution_scope_id, status, created_at)
  - (warranty_id, created_at, id)

### `handyman_settlement_command_keys`

- FKs: actor_user_id→users, unit_id→handyman_settlement_units
- Referenced by: none
- Indexes (1):
  - UNIQUE (idempotency_key)

### `handyman_settlement_events`

Append-only settlement decision events.

- FKs: actor_user_id→users, reconciliation_id→handyman_settlement_reconciliations, unit_id→handyman_settlement_units
- Referenced by: none
- Indexes (3):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - UNIQUE (unit_id, state)

### `handyman_settlement_exceptions`

- FKs: actor_user_id→users, unit_id→handyman_settlement_units
- Referenced by: none
- Indexes (4):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - UNIQUE (unit_id, ledger_correction_id) WHERE (ledger_correction_id IS NOT NULL)
  - UNIQUE (unit_id) WHERE (exception_kind = 'DISPUTED'::text)

### `handyman_settlement_inclusions`

- FKs: actor_user_id→users, entitlement_id→handyman_entitlement_facts, unit_id→handyman_settlement_units
- Referenced by: none
- Indexes (4):
  - UNIQUE (entitlement_id)
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - UNIQUE (unit_id, entitlement_id)

### `handyman_settlement_reconciliations`

- FKs: actor_user_id→users, unit_id→handyman_settlement_units
- Referenced by: handyman_settlement_events
- Indexes (3):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - UNIQUE (reconciliation_seq)

### `handyman_settlement_units`

Settlement units over completed scopes.

- FKs: actor_user_id→users, client_id→clients, client_id→handyman_customer_transactions, client_id→handyman_customer_transactions, currency→handyman_customer_transactions, currency→handyman_customer_transactions, execution_scope_id→handyman_execution_scopes, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions, transaction_id→handyman_customer_transactions
- Referenced by: handyman_settlement_command_keys, handyman_settlement_events, handyman_settlement_exceptions, handyman_settlement_inclusions, handyman_settlement_reconciliations
- Indexes (3):
  - UNIQUE (idempotency_key)
  - UNIQUE (id)
  - UNIQUE (transaction_id)

### `handyman_unit_access_readiness`

Readiness stage: unit-access readiness rows (one ACTIVE per request).

- FKs: area_id→areas, authorized_by_user_id→users, building_id→buildings, client_id→clients, floor_id→floors, handyman_request_id→handyman_service_requests, room_id→rooms, space_id→spaces, supersedes_readiness_id→handyman_unit_access_readiness
- Referenced by: handyman_unit_access_readiness
- Indexes (3):
  - UNIQUE (handyman_request_id) WHERE (status = 'ACTIVE'::text)
  - (client_id, created_at)
  - UNIQUE (id)

### `handyman_visit_appointments`

Tenant visit appointments (INSPECTION/EXECUTION kinds, state machine, one live per request+kind).

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, client_id→handyman_service_requests, client_id→handyman_service_requests, confirmed_by_user_id→users, created_by_user_id→users, execution_scope_id→handyman_execution_scopes, handyman_request_id→handyman_service_requests, handyman_request_id→handyman_service_requests, supersedes_appointment_id→handyman_visit_appointments, tenant_company_id→tenant_companies
- Referenced by: handyman_visit_appointments, handyman_visit_attempts, handyman_visit_capacity_reservations
- Indexes (5):
  - UNIQUE (id, client_id)
  - UNIQUE (handyman_request_id, kind) WHERE (state = ANY (ARRAY['PROPOSED'::text, 'TENANT_SELECTED'::text, 'CONFIRMED'::text, 'IN_PROGRESS'::text]))
  - UNIQUE (id)
  - (client_id, handyman_request_id, kind, created_at DESC)
  - (client_id, resource_type, resource_id, start_at)

### `handyman_visit_attempts`

Append-only visit attempt outcomes with idempotency keys.

- FKs: actor_user_id→users, appointment_id→handyman_visit_appointments
- Referenced by: none
- Indexes (3):
  - UNIQUE (appointment_id, idempotency_key)
  - (appointment_id, recorded_at DESC)
  - UNIQUE (id)

### `handyman_visit_capacity_reservations`

GiST exclusion capacity reservations (no double-book per resource window).

- FKs: appointment_id→handyman_visit_appointments, appointment_id→handyman_visit_appointments, client_id→handyman_visit_appointments, client_id→handyman_visit_appointments
- Referenced by: none
- Indexes (3):
  - (client_id, resource_type, resource_id, tstzrange(start_at, end_at, '[)'::text)) WHERE active
  - UNIQUE (appointment_id)
  - UNIQUE (id)

### `handyman_work_crews`

- FKs: client_id→clients, created_by_user_id→users, handyman_provider_context_id→handyman_provider_contexts
- Referenced by: handyman_crew_leads, handyman_crew_memberships, handyman_entitlement_facts, handyman_execution_scope_assignments
- Indexes (3):
  - UNIQUE (handyman_provider_context_id, code)
  - UNIQUE (id)
  - (client_id, created_at)

### `handyman_work_session_events`

- FKs: actor_user_id→users, client_id→clients, execution_scope_id→handyman_execution_scopes, session_id→handyman_work_sessions
- Referenced by: handyman_work_session_helper_presence
- Indexes (3):
  - UNIQUE (session_id, event_type, idempotency_key)
  - UNIQUE (id)
  - (session_id, occurred_at)

### `handyman_work_session_helper_presence`

- FKs: client_id→clients, event_id→handyman_work_session_events, execution_scope_id→handyman_execution_scopes, helper_user_id→users, helper_worker_id→handyman_worker_contexts, session_id→handyman_work_sessions
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (session_id, event_id)

### `handyman_work_sessions`

Worker check-in/out sessions (one open session per scope).

- FKs: assignment_id→handyman_execution_scope_assignments, client_id→clients, execution_scope_id→handyman_execution_scopes, lead_user_id→users, lead_worker_id→handyman_worker_contexts
- Referenced by: handyman_evidence_records, handyman_qc_runs, handyman_work_session_events, handyman_work_session_helper_presence
- Indexes (3):
  - UNIQUE (execution_scope_id) WHERE (status <> 'CHECKED_OUT'::text)
  - UNIQUE (id)
  - (execution_scope_id, created_at)

### `handyman_worker_contexts`

- FKs: client_id→clients, created_by_user_id→users, handyman_provider_context_id→handyman_provider_contexts, workforce_profile_id→workforce_profiles
- Referenced by: handyman_crew_memberships, handyman_entitlement_facts, handyman_work_session_helper_presence, handyman_work_sessions
- Indexes (4):
  - UNIQUE (handyman_provider_context_id, workforce_profile_id)
  - UNIQUE (id)
  - (handyman_provider_context_id, workforce_profile_id)
  - (client_id, created_at)

### `host_confirmations`

- FKs: building_id→buildings, client_id→clients, confirmed_by_user_id→users, created_by_user_id→users, expected_visitor_id→expected_visitors, host_user_id→users, host_workforce_id→workforce_profiles, walk_in_visit_id→walk_in_visits
- Referenced by: none
- Indexes (7):
  - (building_id, status)
  - (client_id, status)
  - UNIQUE (expected_visitor_id) WHERE (expected_visitor_id IS NOT NULL)
  - (host_user_id)
  - (host_workforce_id)
  - UNIQUE (id)
  - UNIQUE (walk_in_visit_id) WHERE (walk_in_visit_id IS NOT NULL)

### `housekeeping_complaint_bindings`

- FKs: building_id→buildings, cleaning_area_id→cleaning_areas, client_id→clients, created_by_user_id→users, finding_id→findings, work_request_id→work_requests
- Referenced by: none
- Indexes (7):
  - (cleaning_area_id, status)
  - UNIQUE (complaint_reference, housekeeping_source_type, housekeeping_source_id) WHERE ((status = 'ACTIVE'::text) AND (housekeeping_source_id IS NOT NULL))
  - UNIQUE (id)
  - (building_id, status)
  - (finding_id)
  - (complaint_reference)
  - (work_request_id)

### `housekeeping_finding_links`

- FKs: area_id→areas, building_id→buildings, cleaning_area_id→cleaning_areas, client_id→clients, created_by_user_id→users, finding_id→findings, floor_id→floors, functional_location_id→functional_locations, room_id→rooms
- Referenced by: none
- Indexes (6):
  - (cleaning_area_id)
  - (building_id)
  - UNIQUE (finding_id)
  - (finding_id)
  - UNIQUE (id)
  - (source_type, source_id)

### `immediate_actions`

- FKs: completed_by_user_id→users, created_by_user_id→users, incident_id→incidents, responsible_user_id→users
- Referenced by: none
- Indexes (5):
  - (incident_id, taken_at DESC)
  - UNIQUE (id)
  - (responsible_user_id)
  - (status, taken_at DESC)
  - (action_type, status)

### `incidents`

- FKs: area_id→areas, building_id→buildings, cancelled_by_user_id→users, client_id→clients, closed_by_user_id→users, floor_id→floors, functional_location_id→functional_locations, reported_by_user_id→users, room_id→rooms, space_id→spaces
- Referenced by: asset_failure_incidents, corrective_actions, finding_escalation_incidents, immediate_actions, operational_incidents
- Indexes (14):
  - (area_id)
  - (building_id, status, reported_at DESC)
  - (client_id, status, reported_at DESC)
  - (building_id, closed_at DESC) WHERE (status = 'CLOSED'::text)
  - (floor_id)
  - (functional_location_id)
  - UNIQUE (client_id, incident_number)
  - UNIQUE (id)
  - (priority, status, reported_at DESC)
  - (reported_by_user_id, reported_at DESC)
  - (room_id)
  - (severity, status, reported_at DESC)
  - (space_id)
  - (incident_type, status, reported_at DESC)

### `inspection_bindings`

- FKs: asset_id→assets, building_id→buildings, checklist_template_id→checklist_templates, client_id→clients, created_by_user_id→users, functional_location_id→functional_locations
- Referenced by: checklist_executions, permit_equipment
- Indexes (5):
  - UNIQUE (asset_id, checklist_template_id) WHERE (status = 'ACTIVE'::text)
  - (asset_id, status)
  - (building_id, status)
  - UNIQUE (id)
  - (checklist_template_id, status)

### `integration_outbox_events`

Integration outbox (dispatcher fan-out source).

- FKs: building_id→buildings, client_id→clients, operational_event_id→operational_events
- Referenced by: integration_webhook_deliveries
- Indexes (4):
  - (client_id, created_at)
  - (status, created_at)
  - UNIQUE (operational_event_id)
  - UNIQUE (id)

### `integration_webhook_deliveries`

Webhook delivery queue with retry scheduling.

- FKs: building_id→buildings, client_id→clients, endpoint_id→integration_webhook_endpoints, outbox_event_id→integration_outbox_events
- Referenced by: none
- Indexes (5):
  - (client_id, created_at DESC)
  - (COALESCE(next_retry_at, '-infinity'::timestamp with time zone), id) WHERE (status = ANY (ARRAY['PENDING'::text, 'RETRY_SCHEDULED'::text]))
  - (endpoint_id, created_at DESC)
  - UNIQUE (outbox_event_id, endpoint_id)
  - UNIQUE (id)

### `integration_webhook_endpoints`

- FKs: building_id→buildings, client_id→clients
- Referenced by: integration_webhook_deliveries
- Indexes (2):
  - (client_id, status)
  - UNIQUE (id)

### `inventory_asset_spare_parts`

- FKs: asset_id→assets, building_id→buildings, client_id→clients, item_id→inventory_items
- Referenced by: none
- Indexes (6):
  - (asset_id, status)
  - UNIQUE (asset_id, item_id)
  - (building_id, status)
  - (client_id, status)
  - (item_id, status)
  - UNIQUE (id)

### `inventory_housekeeping_consumable_bindings`

- FKs: building_id→buildings, cleaning_area_id→cleaning_areas, client_id→clients, consumable_requirement_id→consumable_requirements, item_id→inventory_items, warehouse_id→inventory_warehouses
- Referenced by: none
- Indexes (8):
  - (building_id, status)
  - (cleaning_area_id, status)
  - (client_id, status)
  - (item_id, status)
  - (consumable_requirement_id, status)
  - UNIQUE (consumable_requirement_id, warehouse_id, item_id)
  - (warehouse_id, status)
  - UNIQUE (id)

### `inventory_items`

- FKs: client_id→clients, uom_id→units_of_measure
- Referenced by: handyman_common_material_profiles, handyman_material_execution_lines, handyman_quotation_lines, inventory_asset_spare_parts, inventory_housekeeping_consumable_bindings, inventory_material_reservations, inventory_minimum_stocks, inventory_stock_adjustments, inventory_stock_balances, inventory_stock_movements, inventory_stock_transfers, inventory_work_order_material_usages, material_requests, price_catalog_entries, purchase_order_lines, receivings, rfq_lines
- Indexes (7):
  - (category) WHERE (category IS NOT NULL)
  - UNIQUE (client_id, code)
  - (client_id, status)
  - UNIQUE (id)
  - UNIQUE (id, client_id)
  - (client_id, item_type, status)
  - (uom_id)

### `inventory_material_reservations`

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, consumed_by_user_id→users, created_by_user_id→users, item_id→inventory_items, material_request_id→material_requests, released_by_user_id→users, uom_id→units_of_measure, warehouse_id→inventory_warehouses
- Referenced by: inventory_work_order_material_usages
- Indexes (6):
  - (building_id, status, created_at DESC)
  - (client_id, status, created_at DESC)
  - (created_by_user_id, created_at DESC)
  - (material_request_id, status, created_at DESC)
  - UNIQUE (id)
  - (warehouse_id, item_id, status)

### `inventory_minimum_stocks`

- FKs: building_id→buildings, client_id→clients, item_id→inventory_items, warehouse_id→inventory_warehouses
- Referenced by: none
- Indexes (6):
  - (building_id, status)
  - (client_id, status)
  - (item_id, status)
  - UNIQUE (id)
  - (warehouse_id, status)
  - UNIQUE (warehouse_id, item_id)

### `inventory_stock_adjustments`

- FKs: building_id→buildings, client_id→clients, item_id→inventory_items, performed_by_user_id→users, warehouse_id→inventory_warehouses
- Referenced by: none
- Indexes (6):
  - (building_id, adjusted_at DESC)
  - (client_id, adjusted_at DESC)
  - (item_id, adjusted_at DESC)
  - (adjustment_type, adjusted_at DESC)
  - (warehouse_id, adjusted_at DESC)
  - UNIQUE (id)

### `inventory_stock_balances`

- FKs: building_id→buildings, client_id→clients, item_id→inventory_items, warehouse_id→inventory_warehouses
- Referenced by: none
- Indexes (7):
  - (building_id)
  - (client_id, building_id)
  - (item_id)
  - (available_quantity) WHERE (available_quantity <= (0)::numeric)
  - UNIQUE (id)
  - (warehouse_id)
  - UNIQUE (warehouse_id, item_id)

### `inventory_stock_movements`

- FKs: building_id→buildings, client_id→clients, item_id→inventory_items, performed_by_user_id→users, uom_id→units_of_measure, warehouse_id→inventory_warehouses
- Referenced by: inventory_work_order_material_usages, receivings
- Indexes (7):
  - (building_id, movement_date DESC)
  - (client_id, movement_date DESC)
  - (item_id, movement_date DESC)
  - (performed_by_user_id, movement_date DESC)
  - UNIQUE (id)
  - (movement_type, movement_date DESC)
  - (warehouse_id, movement_date DESC)

### `inventory_stock_transfers`

- FKs: client_id→clients, destination_building_id→buildings, destination_warehouse_id→inventory_warehouses, item_id→inventory_items, performed_by_user_id→users, source_building_id→buildings, source_warehouse_id→inventory_warehouses
- Referenced by: none
- Indexes (6):
  - UNIQUE (id)
  - (source_building_id, destination_building_id, transfer_date DESC)
  - (client_id, transfer_date DESC)
  - (destination_warehouse_id, transfer_date DESC)
  - (item_id, transfer_date DESC)
  - (source_warehouse_id, transfer_date DESC)

### `inventory_warehouses`

- FKs: building_id→buildings, client_id→clients, functional_location_id→functional_locations
- Referenced by: inventory_housekeeping_consumable_bindings, inventory_material_reservations, inventory_minimum_stocks, inventory_stock_adjustments, inventory_stock_balances, inventory_stock_movements, inventory_stock_transfers, inventory_work_order_material_usages, material_requests, receivings
- Indexes (5):
  - UNIQUE (building_id, code)
  - (building_id, status)
  - (client_id, status)
  - (functional_location_id) WHERE (functional_location_id IS NOT NULL)
  - UNIQUE (id)

### `inventory_work_order_material_usages`

- FKs: building_id→buildings, client_id→clients, item_id→inventory_items, material_request_id→material_requests, reservation_id→inventory_material_reservations, stock_movement_id→inventory_stock_movements, uom_id→units_of_measure, used_by_user_id→users, warehouse_id→inventory_warehouses, work_order_id→work_orders
- Referenced by: operational_budget_source_bindings
- Indexes (9):
  - (building_id, used_at DESC)
  - (client_id, used_at DESC)
  - (item_id, used_at DESC)
  - (material_request_id, used_at DESC) WHERE (material_request_id IS NOT NULL)
  - (reservation_id, used_at DESC) WHERE (reservation_id IS NOT NULL)
  - (stock_movement_id) WHERE (stock_movement_id IS NOT NULL)
  - (warehouse_id, used_at DESC)
  - (work_order_id, used_at DESC)
  - UNIQUE (id)

### `invoice_payment_status`

Invoice payment status projection (per invoice; building/tenant indexed).

- FKs: building_id→buildings, client_id→clients, invoice_id→tenant_invoices, recorded_by_user_id→users, tenant_company_id→tenant_companies
- Referenced by: invoice_payment_status_history, payment_receipts
- Indexes (5):
  - (building_id, payment_status)
  - UNIQUE (invoice_id)
  - UNIQUE (id)
  - (payment_status, updated_at DESC)
  - (tenant_company_id, payment_status)

### `invoice_payment_status_history`

Append-only payment-status history.

- FKs: changed_by_user_id→users, invoice_payment_status_id→invoice_payment_status
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (invoice_payment_status_id, changed_at)

### `licenses`

- FKs: subscription_id→subscriptions
- Referenced by: none
- Indexes (3):
  - UNIQUE (subscription_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (subscription_id)

### `log_sheet_bindings`

- FKs: asset_id→assets, building_id→buildings, client_id→clients, created_by_user_id→users, form_template_id→form_templates, form_template_version_id→form_template_versions, functional_location_id→functional_locations
- Referenced by: form_instances
- Indexes (5):
  - UNIQUE (asset_id, form_template_id) WHERE (status = 'ACTIVE'::text)
  - (asset_id, status)
  - (building_id, status)
  - UNIQUE (id)
  - (form_template_id, status)

### `maintenance_bindings`

- FKs: asset_id→assets, building_id→buildings, client_id→clients, created_by_user_id→users, functional_location_id→functional_locations, schedule_definition_id→schedule_definitions, work_order_id→work_orders
- Referenced by: generated_tasks
- Indexes (7):
  - (asset_id, status)
  - (building_id, status)
  - UNIQUE (id)
  - UNIQUE (schedule_definition_id)
  - (schedule_definition_id)
  - UNIQUE (work_order_id)
  - (work_order_id)

### `material_requests`

- FKs: approved_by_user_id→users, building_id→buildings, client_id→clients, item_id→inventory_items, purchase_request_id→purchase_requests, requested_by_user_id→users, uom_id→units_of_measure, warehouse_id→inventory_warehouses
- Referenced by: inventory_material_reservations, inventory_work_order_material_usages, operational_commitments, procurement_approval_bindings, purchase_order_lines, receivings, rfq_lines, work_order_procurement_bindings
- Indexes (7):
  - (building_id, status, created_at)
  - (client_id, status)
  - (item_id, status)
  - UNIQUE (id)
  - (purchase_request_id, status)
  - UNIQUE (id, client_id, building_id, purchase_request_id)
  - (warehouse_id, status)

### `meter_reading_bindings`

- FKs: asset_id→assets, building_id→buildings, client_id→clients, created_by_user_id→users, form_field_id→form_fields, functional_location_id→functional_locations, uom_id→units_of_measure
- Referenced by: form_instances, utility_meter_readings
- Indexes (5):
  - UNIQUE (asset_id, form_field_id) WHERE (status = 'ACTIVE'::text)
  - (asset_id, status)
  - (building_id, status)
  - (form_field_id, status)
  - UNIQUE (id)

### `mobile_app_versions`

- FKs: none
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - UNIQUE (platform)

### `mobile_push_tokens`

- FKs: user_id→users
- Referenced by: notification_push_deliveries
- Indexes (5):
  - UNIQUE (id)
  - UNIQUE (push_token) WHERE (status = 'ACTIVE'::text)
  - (push_token)
  - UNIQUE (user_id, device_id) WHERE (status = 'ACTIVE'::text)
  - (user_id, status)

### `mobile_sync_idempotency`

- FKs: user_id→users
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (user_id, operation_id)
  - (user_id, resource_type, resource_id)

### `module_configurations`

- FKs: building_id→buildings, client_id→clients, module_id→modules
- Referenced by: none
- Indexes (4):
  - UNIQUE (building_id, module_id) WHERE (scope_type = 'BUILDING'::text)
  - UNIQUE (client_id, module_id) WHERE (scope_type = 'CLIENT'::text)
  - (module_id)
  - UNIQUE (id)

### `module_entitlements`

- FKs: module_id→modules, subscription_id→subscriptions
- Referenced by: none
- Indexes (5):
  - (module_id)
  - UNIQUE (subscription_id, module_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (subscription_id)
  - (subscription_id) WHERE (source = 'PACKAGE'::text)

### `modules`

- FKs: none
- Referenced by: dashboard_widgets, feature_entitlement_configurations, module_configurations, module_entitlements, navigation_items, package_features, workspaces
- Indexes (2):
  - UNIQUE (code)
  - UNIQUE (id)

### `navigation_items`

- FKs: building_id→buildings, client_id→clients, module_id→modules, permission_id→permissions
- Referenced by: none
- Indexes (5):
  - UNIQUE (building_id, navigation_key) WHERE (scope_type = 'BUILDING'::text)
  - UNIQUE (client_id, navigation_key) WHERE (scope_type = 'CLIENT'::text)
  - (module_id, feature_key)
  - (permission_id)
  - UNIQUE (id)

### `notification_email_deliveries`

- FKs: client_id→clients, delivery_id→notification_outbound_deliveries, recipient_user_id→users, template_key→notification_templates
- Referenced by: none
- Indexes (5):
  - (client_id, created_at DESC)
  - (delivery_id)
  - UNIQUE (id)
  - (recipient_user_id, created_at DESC)
  - (status)

### `notification_escalations`

Due notification escalations (dispatcher queue; bounded retrieval).

- FKs: client_id→clients, current_recipient_user_id→users, template_key→notification_templates
- Referenced by: none
- Indexes (5):
  - (client_id, created_at DESC)
  - (status, escalation_at)
  - UNIQUE (key)
  - UNIQUE (id)
  - (source_entity_type, source_entity_id, status)

### `notification_event_subscriptions`

- FKs: building_id→buildings, client_id→clients, template_key→notification_templates
- Referenced by: none
- Indexes (5):
  - (building_id)
  - (client_id)
  - (event_type, status)
  - UNIQUE (key)
  - UNIQUE (id)

### `notification_outbound_deliveries`

Outbound omnichannel delivery queue with retry scheduling.

- FKs: building_id→buildings, client_id→clients, recipient_user_id→users, template_key→notification_templates
- Referenced by: notification_email_deliveries, notification_push_deliveries, notification_whatsapp_deliveries
- Indexes (7):
  - (client_id, created_at DESC)
  - (COALESCE(next_retry_at, '-infinity'::timestamp with time zone), id) WHERE (status = ANY (ARRAY['PENDING'::text, 'RETRY_SCHEDULED'::text]))
  - UNIQUE (client_id, channel, idempotency_key)
  - UNIQUE (id)
  - (provider_message_id) WHERE (provider_message_id IS NOT NULL)
  - (recipient_user_id, created_at DESC)
  - (source_entity_type, source_entity_id, created_at DESC)

### `notification_push_deliveries`

- FKs: building_id→buildings, client_id→clients, delivery_id→notification_outbound_deliveries, push_token_id→mobile_push_tokens, recipient_user_id→users, template_key→notification_templates
- Referenced by: none
- Indexes (5):
  - (client_id, created_at DESC)
  - (delivery_id)
  - UNIQUE (id)
  - (recipient_user_id, created_at DESC)
  - (push_token_id, created_at DESC)

### `notification_reminders`

Due notification reminders (dispatcher queue; bounded retrieval).

- FKs: client_id→clients, template_key→notification_templates
- Referenced by: none
- Indexes (5):
  - (client_id, created_at DESC)
  - (status, reminder_at)
  - UNIQUE (key)
  - UNIQUE (id)
  - (source_entity_type, source_entity_id, status)

### `notification_secure_links`

- FKs: client_id→clients, recipient_user_id→users
- Referenced by: none
- Indexes (5):
  - (client_id)
  - UNIQUE (id)
  - (recipient_user_id, status, created_at DESC)
  - (target_entity_type, target_entity_id, status)
  - UNIQUE (token_hash)

### `notification_templates`

- FKs: none
- Referenced by: notification_email_deliveries, notification_escalations, notification_event_subscriptions, notification_outbound_deliveries, notification_push_deliveries, notification_reminders, notification_whatsapp_deliveries, notifications, sla_escalation_actions, sla_escalation_levels
- Indexes (3):
  - UNIQUE (key)
  - UNIQUE (id)
  - (status, key)

### `notification_whatsapp_deliveries`

- FKs: client_id→clients, delivery_id→notification_outbound_deliveries, recipient_user_id→users, template_key→notification_templates
- Referenced by: none
- Indexes (5):
  - (client_id, created_at DESC)
  - (delivery_id)
  - UNIQUE (id)
  - (recipient_user_id, created_at DESC)
  - (status)

### `notifications`

- FKs: client_id→clients, recipient_user_id→users, template_key→notification_templates
- Referenced by: none
- Indexes (5):
  - (client_id, created_at DESC)
  - (delivered_at)
  - UNIQUE (id)
  - (recipient_user_id, status, created_at DESC)
  - (source_entity_type, source_entity_id, created_at DESC)

### `operational_budget_categories`

- FKs: budget_id→operational_budgets
- Referenced by: operational_budget_source_bindings, operational_commitments
- Indexes (5):
  - UNIQUE (budget_id, category_code)
  - (budget_id, category_code)
  - UNIQUE (id, budget_id)
  - (category_code)
  - UNIQUE (id)

### `operational_budget_source_bindings`

- FKs: basic_expense_id→basic_expenses, budget_category_id→operational_budget_categories, budget_category_id→operational_budget_categories, budget_id→operational_budgets, budget_id→operational_budgets, budget_id→operational_budgets, budget_id→operational_budget_categories, budget_id→operational_budget_categories, building_id→operational_budgets, building_id→operational_budgets, building_id→buildings, building_id→operational_budgets, client_id→clients, client_id→operational_budgets, client_id→operational_budgets, client_id→operational_budgets, created_by_user_id→users, purchase_order_id→purchase_orders, purchase_order_line_id→purchase_order_lines, removed_by_user_id→users, vendor_invoice_id→vendor_invoices, vendor_service_cost_id→vendor_service_costs, work_order_material_usage_id→inventory_work_order_material_usages
- Referenced by: operational_commitment_entries
- Indexes (11):
  - UNIQUE (basic_expense_id) WHERE ((status = 'ACTIVE'::text) AND (source_type = 'BASIC_EXPENSE'::text))
  - UNIQUE (work_order_material_usage_id) WHERE ((status = 'ACTIVE'::text) AND (source_type = 'WORK_ORDER_MATERIAL'::text))
  - UNIQUE (purchase_order_line_id) WHERE ((status = 'ACTIVE'::text) AND (source_type = 'PO_LINE'::text))
  - UNIQUE (purchase_order_id) WHERE ((status = 'ACTIVE'::text) AND (source_type = 'PURCHASE_ORDER'::text))
  - UNIQUE (vendor_service_cost_id) WHERE ((status = 'ACTIVE'::text) AND (source_type = 'VENDOR_SERVICE_COST'::text))
  - UNIQUE (vendor_invoice_id) WHERE ((status = 'ACTIVE'::text) AND (source_type = 'VENDOR_INVOICE'::text))
  - (budget_id, status, created_at)
  - (budget_category_id, status)
  - (client_id, building_id, status)
  - (currency_status, status)
  - UNIQUE (id)

### `operational_budgets`

- FKs: building_id→buildings, client_id→clients
- Referenced by: operational_budget_categories, operational_budget_source_bindings, operational_commitments
- Indexes (6):
  - (building_id, period_start, period_end)
  - (client_id, building_id, status)
  - (building_id, daterange(period_start, (period_end + 1), '[)'::text)) WHERE (status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text]))
  - UNIQUE (id)
  - UNIQUE (id, client_id, building_id)
  - (status, period_start, period_end)

### `operational_commitment_entries`

- FKs: actor_user_id→users, commitment_id→operational_commitments, source_binding_id→operational_budget_source_bindings
- Referenced by: none
- Indexes (6):
  - UNIQUE (commitment_id, source_binding_id) WHERE ((entry_type = 'ACTUALIZE'::text) AND (source_binding_id IS NOT NULL))
  - (commitment_id, occurred_at, id)
  - UNIQUE (commitment_id, idempotency_key)
  - UNIQUE (id)
  - (request_id) WHERE (request_id IS NOT NULL)
  - (entry_type, occurred_at)

### `operational_commitments`

- FKs: budget_category_id→operational_budget_categories, budget_category_id→operational_budget_categories, budget_id→operational_budgets, budget_id→operational_budget_categories, budget_id→operational_budget_categories, budget_id→operational_budgets, budget_id→operational_budgets, building_id→operational_budgets, building_id→operational_budgets, building_id→operational_budgets, building_id→buildings, client_id→operational_budgets, client_id→operational_budgets, client_id→operational_budgets, client_id→clients, closed_by_user_id→users, created_by_user_id→users, material_request_id→material_requests, overspend_override_by_user_id→users, purchase_order_id→purchase_orders, purchase_order_line_id→purchase_order_lines, vendor_id→vendors, work_order_id→work_orders
- Referenced by: operational_commitment_entries
- Indexes (10):
  - (budget_id, status, created_at)
  - (budget_category_id, status)
  - (client_id, building_id, status)
  - UNIQUE (budget_id, idempotency_key)
  - (material_request_id) WHERE (material_request_id IS NOT NULL)
  - UNIQUE (id)
  - UNIQUE (purchase_order_line_id) WHERE ((purchase_order_line_id IS NOT NULL) AND (status <> 'CANCELLED'::text))
  - UNIQUE (purchase_order_id) WHERE ((purchase_order_id IS NOT NULL) AND (status <> 'CANCELLED'::text))
  - (vendor_id) WHERE (vendor_id IS NOT NULL)
  - (work_order_id) WHERE (work_order_id IS NOT NULL)

### `operational_events`

Append-only operational event log (entity-scoped, request correlation).

- FKs: actor_user_id→users, building_id→buildings, client_id→clients, vendor_work_id→vendor_works
- Referenced by: integration_outbox_events
- Indexes (6):
  - (building_id, occurred_at)
  - (client_id, occurred_at)
  - (entity_type, entity_id, occurred_at)
  - UNIQUE (id)
  - (request_id) WHERE (request_id IS NOT NULL)
  - (vendor_work_id, occurred_at)

### `operational_incidents`

- FKs: created_by_user_id→users, incident_id→incidents, reported_security_post_id→security_posts, reported_shift_assignment_id→workforce_shift_assignments
- Referenced by: none
- Indexes (9):
  - (operational_category, operational_status)
  - UNIQUE (incident_id)
  - (incident_id)
  - (occurred_at DESC)
  - UNIQUE (id)
  - (reported_security_post_id)
  - (reported_shift_assignment_id)
  - (safety_report_type) WHERE (safety_report_type IS NOT NULL)
  - (operational_status, occurred_at DESC)

### `organizations`

- FKs: client_id→clients
- Referenced by: departments, positions, workforce_profiles
- Indexes (3):
  - (client_id)
  - UNIQUE (client_id, code)
  - UNIQUE (id)

### `package_features`

- FKs: capability_code→modules, package_id→saas_packages
- Referenced by: none
- Indexes (2):
  - UNIQUE (package_id, capability_code)
  - UNIQUE (id)

### `package_limits`

- FKs: package_id→saas_packages
- Referenced by: none
- Indexes (2):
  - UNIQUE (package_id, limit_key)
  - UNIQUE (id)

### `patrol_checklist_bindings`

- FKs: building_id→buildings, checklist_template_id→checklist_templates, client_id→clients, created_by_user_id→users, patrol_route_id→patrol_routes, start_security_post_id→security_posts
- Referenced by: checklist_executions
- Indexes (6):
  - UNIQUE (checklist_template_id, patrol_route_id) WHERE (status = 'ACTIVE'::text)
  - (building_id, status)
  - UNIQUE (id)
  - (patrol_route_id, status)
  - (start_security_post_id)
  - (checklist_template_id, status)

### `patrol_point_visits`

- FKs: building_id→buildings, client_id→clients, patrol_route_id→patrol_routes, patrol_route_point_id→patrol_route_points, visited_by_user_id→users
- Referenced by: none
- Indexes (6):
  - (building_id)
  - (client_id, visited_at)
  - UNIQUE (id)
  - (patrol_route_id)
  - (task_id, sequence)
  - UNIQUE (task_id, patrol_route_point_id) WHERE (status = 'VISITED'::text)

### `patrol_route_points`

- FKs: area_id→areas, building_id→buildings, client_id→clients, floor_id→floors, functional_location_id→functional_locations, patrol_route_id→patrol_routes, room_id→rooms, space_id→spaces
- Referenced by: patrol_point_visits
- Indexes (8):
  - (area_id)
  - (building_id)
  - (functional_location_id)
  - UNIQUE (id)
  - (room_id)
  - (patrol_route_id, sequence)
  - UNIQUE (patrol_route_id, sequence)
  - (space_id)

### `patrol_routes`

- FKs: building_id→buildings, client_id→clients, start_security_post_id→security_posts
- Referenced by: patrol_checklist_bindings, patrol_point_visits, patrol_route_points, patrol_schedule_bindings, security_finding_links, security_shift_handover_bindings
- Indexes (5):
  - UNIQUE (building_id, code)
  - (building_id, status)
  - (client_id, status)
  - UNIQUE (id)
  - (start_security_post_id)

### `patrol_schedule_bindings`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, patrol_route_id→patrol_routes, schedule_definition_id→schedule_definitions, start_security_post_id→security_posts
- Referenced by: none
- Indexes (8):
  - UNIQUE (patrol_route_id, schedule_definition_id) WHERE (status = 'ACTIVE'::text)
  - (building_id, status)
  - (client_id, status)
  - UNIQUE (id)
  - (patrol_route_id, status)
  - UNIQUE (schedule_definition_id) WHERE (status = 'ACTIVE'::text)
  - (schedule_definition_id)
  - (start_security_post_id)

### `payment_receipt_history`

- FKs: changed_by_user_id→users, payment_receipt_id→payment_receipts
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (payment_receipt_id, changed_at)

### `payment_receipts`

Payment receipts per invoice (client-scoped receipt numbers).

- FKs: building_id→buildings, client_id→clients, invoice_id→tenant_invoices, invoice_payment_status_id→invoice_payment_status, issued_by_user_id→users, tenant_company_id→tenant_companies, voided_by_user_id→users
- Referenced by: payment_receipt_history
- Indexes (7):
  - (building_id, received_at DESC)
  - (invoice_id, received_at DESC)
  - UNIQUE (client_id, receipt_number)
  - (invoice_payment_status_id, status, received_at)
  - UNIQUE (id)
  - UNIQUE (client_id, payment_reference) WHERE (payment_reference IS NOT NULL)
  - (tenant_company_id, received_at DESC)

### `permissions`

Permission codes.

- FKs: none
- Referenced by: dashboard_widgets, navigation_items, role_permission_assignments, workspaces
- Indexes (2):
  - UNIQUE (code)
  - UNIQUE (id)

### `permit_applications`

- FKs: cancelled_by_user_id→users, created_by_user_id→users, permit_id→permits, submitted_by_user_id→users
- Referenced by: permit_approval_bindings, permit_equipment, permit_safety_requirements, permit_validities, permit_work_contexts, permit_work_lifecycles, permit_workers
- Indexes (5):
  - (created_by_user_id, created_at)
  - UNIQUE (permit_id)
  - UNIQUE (id)
  - (requested_work_at)
  - (status, requested_work_at)

### `permit_approval_bindings`

- FKs: created_by_user_id→users, permit_application_id→permit_applications, review_id→reviews
- Referenced by: none
- Indexes (5):
  - (permit_application_id, created_at)
  - UNIQUE (id)
  - UNIQUE (permit_application_id, approval_stage, approval_type)
  - UNIQUE (review_id)
  - (approval_stage, approval_type)

### `permit_equipment`

- FKs: asset_certification_id→asset_certifications, asset_id→assets, asset_identifier_id→asset_identifiers, created_by_user_id→users, deactivated_by_user_id→users, equipment_profile_id→equipment_profiles, inspection_binding_id→inspection_bindings, inspection_execution_id→checklist_executions, permit_application_id→permit_applications, updated_by_user_id→users
- Referenced by: none
- Indexes (6):
  - UNIQUE (permit_application_id, asset_id) WHERE (status = 'ACTIVE'::text)
  - (permit_application_id, status, valid_from)
  - (asset_id, status)
  - (asset_certification_id)
  - (inspection_execution_id)
  - UNIQUE (id)

### `permit_safety_requirements`

- FKs: checklist_execution_id→checklist_executions, checklist_template_id→checklist_templates, created_by_user_id→users, evidence_requirement_id→evidence_requirements, permit_application_id→permit_applications, updated_by_user_id→users
- Referenced by: none
- Indexes (6):
  - (permit_application_id, readiness_status)
  - (checklist_execution_id)
  - (evidence_requirement_id)
  - UNIQUE (id)
  - UNIQUE (permit_application_id, requirement_type)
  - (work_type, readiness_status)

### `permit_validities`

- FKs: created_by_user_id→users, permit_application_id→permit_applications, revoked_by_user_id→users
- Referenced by: none
- Indexes (5):
  - UNIQUE (id)
  - (permit_application_id, created_at DESC)
  - UNIQUE (permit_application_id) WHERE (status = ANY (ARRAY['PENDING'::text, 'VALID'::text]))
  - (valid_from, valid_until)
  - (status, valid_until)

### `permit_work_contexts`

- FKs: area_id→areas, building_id→buildings, created_by_user_id→users, floor_id→floors, functional_location_id→functional_locations, permit_application_id→permit_applications, room_id→rooms, updated_by_user_id→users
- Referenced by: none
- Indexes (8):
  - UNIQUE (permit_application_id)
  - (area_id)
  - (building_id)
  - (floor_id)
  - (functional_location_id)
  - UNIQUE (id)
  - (room_id)
  - (work_type)

### `permit_work_lifecycles`

- FKs: closed_by_user_id→users, permit_application_id→permit_applications, started_by_user_id→users
- Referenced by: none
- Indexes (4):
  - UNIQUE (permit_application_id)
  - (started_by_user_id, started_at)
  - (status, started_at)
  - UNIQUE (id)

### `permit_workers`

- FKs: created_by_user_id→users, deactivated_by_user_id→users, permit_application_id→permit_applications, updated_by_user_id→users, vendor_workforce_binding_id→vendor_workforce_bindings
- Referenced by: none
- Indexes (4):
  - UNIQUE (permit_application_id, vendor_workforce_binding_id) WHERE (status = 'ACTIVE'::text)
  - (permit_application_id, status, valid_from)
  - (vendor_workforce_binding_id, status)
  - UNIQUE (id)

### `permits`

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, contractor_vendor_id→vendors, created_by_user_id→users, tenant_contractor_relationship_id→tenant_contractor_relationships
- Referenced by: permit_applications
- Indexes (6):
  - (building_id, status, requested_at DESC)
  - (contractor_vendor_id, status, requested_at DESC)
  - UNIQUE (client_id, permit_number)
  - UNIQUE (id)
  - (tenant_contractor_relationship_id, requested_at DESC)
  - (permit_type, status, requested_at DESC)

### `platform_configurations`

- FKs: updated_by_user_id→users
- Referenced by: none
- Indexes (2):
  - UNIQUE (key)
  - UNIQUE (id)

### `platform_support_sessions`

- FKs: customer_id→clients, support_actor_user_id→users
- Referenced by: none
- Indexes (4):
  - (support_actor_user_id)
  - (customer_id)
  - (expires_at)
  - UNIQUE (id)

### `positions`

- FKs: department_id→departments, organization_id→organizations
- Referenced by: workforce_profiles
- Indexes (4):
  - UNIQUE (organization_id, code)
  - (department_id)
  - (organization_id)
  - UNIQUE (id)

### `price_catalog_entries`

- FKs: activated_by_user_id→users, approved_by_user_id→users, building_id→buildings, client_id→service_catalog, client_id→service_catalog, client_id→units_of_measure, client_id→inventory_items, client_id→inventory_items, client_id→units_of_measure, client_id→vendors, client_id→vendors, client_id→clients, created_by_user_id→users, deactivated_by_user_id→users, item_id→inventory_items, item_id→inventory_items, replaced_by_entry_id→price_catalog_entries, service_id→service_catalog, service_id→service_catalog, uom_id→units_of_measure, uom_id→units_of_measure, vendor_id→vendors, vendor_id→vendors
- Referenced by: price_catalog_entries, rfq_comparison_lines
- Indexes (12):
  - (building_id, status) WHERE (building_id IS NOT NULL)
  - (client_id, item_id, status)
  - (client_id, status, effective_from DESC)
  - UNIQUE (client_id, idempotency_key)
  - (client_id, item_id, uom_id, currency, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), tstzrange(effective_from, effective_to, '[)'::text)) WHERE ((status = 'ACTIVE'::text) AND (source_mode = 'MATERIAL'::text))
  - UNIQUE (id)
  - (client_id, item_id, currency, uom_id, building_id, vendor_id, effective_from DESC) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id, client_id)
  - (client_id, service_id, currency, building_id, vendor_id, effective_from DESC) WHERE ((status = 'ACTIVE'::text) AND (source_mode = 'SERVICE'::text))
  - (client_id, service_id, currency, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), tstzrange(effective_from, effective_to, '[)'::text)) WHERE ((status = 'ACTIVE'::text) AND (source_mode = 'SERVICE'::text))
  - UNIQUE (replaced_by_entry_id) WHERE (replaced_by_entry_id IS NOT NULL)
  - (vendor_id, status) WHERE (vendor_id IS NOT NULL)

### `procurement_approval_bindings`

- FKs: approver_user_id→users, building_id→rfqs, building_id→rfqs, building_id→buildings, building_id→rfqs, client_id→clients, client_id→rfqs, client_id→rfqs, client_id→rfqs, created_by_user_id→users, material_request_id→material_requests, purchase_request_id→purchase_requests, recommendation_id→rfq_recommendations, rfq_id→rfqs, rfq_id→rfqs, rfq_id→rfqs, service_request_id→service_requests
- Referenced by: rfq_awards
- Indexes (9):
  - (approver_user_id, status, created_at)
  - UNIQUE (id)
  - (building_id, status, created_at)
  - (client_id, status, created_at)
  - UNIQUE (material_request_id, approval_type, approver_user_id) WHERE ((status = 'PENDING'::text) AND (material_request_id IS NOT NULL))
  - UNIQUE (purchase_request_id, approval_type, approver_user_id) WHERE ((status = 'PENDING'::text) AND (purchase_request_id IS NOT NULL))
  - (rfq_id, status, created_at) WHERE (rfq_id IS NOT NULL)
  - UNIQUE (rfq_id, approval_type) WHERE ((request_type = 'RFQ'::text) AND (status = 'PENDING'::text))
  - UNIQUE (service_request_id, approval_type, approver_user_id) WHERE ((status = 'PENDING'::text) AND (service_request_id IS NOT NULL))

### `product_add_ons`

- FKs: product_id→saas_products
- Referenced by: saas_subscription_add_ons
- Indexes (4):
  - UNIQUE (id)
  - UNIQUE (product_id, code)
  - (product_id, created_at DESC)
  - (status) WHERE (status = 'ACTIVE'::text)

### `properties`

Properties under a client.

- FKs: client_id→clients
- Referenced by: buildings, campuses, handyman_care_property_grants, handyman_handoff_exchanges, saas_usage_records
- Indexes (4):
  - UNIQUE (client_id, code)
  - (client_id)
  - UNIQUE (id)
  - (status)

### `public_area_inspection_bindings`

- FKs: area_id→areas, building_id→buildings, checklist_template_id→checklist_templates, cleaning_area_id→cleaning_areas, client_id→clients, created_by_user_id→users, floor_id→floors, functional_location_id→functional_locations, room_id→rooms
- Referenced by: checklist_executions
- Indexes (10):
  - UNIQUE (cleaning_area_id, checklist_template_id) WHERE (status = 'ACTIVE'::text)
  - (cleaning_area_id, status)
  - (building_id, status)
  - (client_id, status)
  - (floor_id)
  - (functional_location_id)
  - UNIQUE (id)
  - (room_id)
  - (checklist_template_id, status)
  - (area_id)

### `purchase_order_history`

- FKs: changed_by_user_id→users, purchase_order_id→purchase_orders
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (purchase_order_id, changed_at)

### `purchase_order_line_history`

- FKs: changed_by_user_id→users, purchase_order_id→purchase_orders, purchase_order_line_id→purchase_order_lines
- Referenced by: none
- Indexes (3):
  - (purchase_order_line_id, changed_at)
  - UNIQUE (id)
  - (purchase_order_id, changed_at)

### `purchase_order_lines`

- FKs: building_id→buildings, client_id→clients, client_id→service_catalog, client_id→service_catalog, created_by_user_id→users, item_id→inventory_items, material_request_id→material_requests, purchase_order_id→purchase_orders, service_request_id→service_requests, source_service_id→service_catalog, source_service_id→service_catalog, uom_id→units_of_measure
- Referenced by: operational_budget_source_bindings, operational_commitments, purchase_order_line_history, rfq_award_po_line_provenance
- Indexes (10):
  - (building_id)
  - (item_id) WHERE (item_id IS NOT NULL)
  - (material_request_id) WHERE (material_request_id IS NOT NULL)
  - UNIQUE (id)
  - (purchase_order_id, line_number)
  - UNIQUE (purchase_order_id, line_number)
  - UNIQUE (purchase_order_id, material_request_id)
  - UNIQUE (purchase_order_id, service_request_id)
  - (service_request_id) WHERE (service_request_id IS NOT NULL)
  - (source_service_id) WHERE (source_service_id IS NOT NULL)

### `purchase_order_readiness`

- FKs: building_id→buildings, client_id→clients, prepared_by_user_id→users, purchase_request_id→purchase_requests, service_request_id→service_requests, vendor_id→vendors
- Referenced by: purchase_orders, rfq_award_po_conversions
- Indexes (5):
  - (building_id, readiness, created_at)
  - (request_type, purchase_request_id, service_request_id)
  - (vendor_id, readiness)
  - UNIQUE (vendor_id, purchase_request_id, service_request_id)
  - UNIQUE (id)

### `purchase_orders`

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, created_by_user_id→users, issued_by_user_id→users, po_readiness_id→purchase_order_readiness, purchase_request_id→purchase_requests, service_request_id→service_requests, vendor_id→vendors
- Referenced by: operational_budget_source_bindings, operational_commitments, purchase_order_history, purchase_order_line_history, purchase_order_lines, rfq_award_po_conversions, rfq_award_po_line_provenance, vendor_invoices, work_contracts, work_order_procurement_bindings
- Indexes (10):
  - (building_id, status, po_date DESC)
  - UNIQUE (client_id, po_number)
  - (issued_at DESC) WHERE (issued_at IS NOT NULL)
  - UNIQUE (id)
  - (purchase_request_id) WHERE (purchase_request_id IS NOT NULL)
  - UNIQUE (po_readiness_id) WHERE (status <> 'CANCELLED'::text)
  - (po_readiness_id)
  - UNIQUE (id, client_id, building_id, vendor_id)
  - (service_request_id) WHERE (service_request_id IS NOT NULL)
  - (vendor_id, status, po_date DESC)

### `purchase_requests`

- FKs: building_id→buildings, client_id→clients, requested_by_user_id→users, work_order_id→work_orders
- Referenced by: material_requests, procurement_approval_bindings, purchase_order_readiness, purchase_orders, receivings, rfqs, service_requests, vendor_selection_readiness, work_order_procurement_bindings
- Indexes (8):
  - UNIQUE (client_id, request_number)
  - (building_id, status, requested_at)
  - (client_id, status, requested_at)
  - UNIQUE (id)
  - (request_type, status)
  - (requested_by_user_id, status)
  - UNIQUE (id, client_id, building_id)
  - UNIQUE (work_order_id) WHERE (work_order_id IS NOT NULL)

### `quality_audits`

- FKs: auditor_user_id→users, building_id→buildings, cleaning_area_id→cleaning_areas, client_id→clients
- Referenced by: none
- Indexes (7):
  - (cleaning_area_id, status)
  - (auditor_user_id)
  - (building_id, status)
  - UNIQUE (id)
  - (result)
  - UNIQUE (source_type, source_id) WHERE (status = 'DRAFT'::text)
  - (source_type, source_id)

### `receivings`

- FKs: building_id→buildings, client_id→clients, item_id→inventory_items, material_request_id→material_requests, purchase_request_id→purchase_requests, received_by_user_id→users, service_request_id→service_requests, stock_movement_id→inventory_stock_movements, uom_id→units_of_measure, vendor_id→vendors, warehouse_id→inventory_warehouses
- Referenced by: work_order_procurement_bindings
- Indexes (6):
  - (building_id, status, received_at)
  - (material_request_id, status) WHERE (material_request_id IS NOT NULL)
  - UNIQUE (id)
  - (receiving_type, status)
  - (request_type, purchase_request_id, service_request_id)
  - (vendor_id, status, received_at)

### `report_archives`

- FKs: building_id→buildings, client_id→clients, requested_by_user_id→users, retention_policy_id→evidence_retention_policies, supersedes_archive_id→report_archives
- Referenced by: report_archives
- Indexes (7):
  - (building_id, created_at DESC, id DESC) WHERE (building_id IS NOT NULL)
  - (client_id, created_at DESC, id DESC)
  - (dataset, format, created_at DESC)
  - UNIQUE (requested_by_user_id, client_id, idempotency_key_hash) WHERE (idempotency_key_hash IS NOT NULL)
  - UNIQUE (id)
  - (building_ids)
  - (status, next_attempt_at, requested_at)

### `request_idempotency_records`

- FKs: actor_user_id→users
- Referenced by: none
- Indexes (3):
  - UNIQUE (actor_user_id, operation_key, idempotency_key_hash)
  - (created_at)
  - UNIQUE (id)

### `reviews`

Approval/review records for findings, corrective actions, documents (PENDING uniqueness per type).

- FKs: client_id→clients, reviewer_user_id→users
- Referenced by: bast_submission_attempts, finding_rework_cycles, permit_approval_bindings, supervisor_inspections, vendor_rework_cycles
- Indexes (6):
  - UNIQUE (target_id) WHERE ((target_type = 'CORRECTIVE_ACTION'::text) AND (status = 'PENDING'::text))
  - UNIQUE (target_id) WHERE ((target_type = 'FINDING'::text) AND (status = 'PENDING'::text))
  - (client_id, status)
  - UNIQUE (id)
  - (target_type, target_id, created_at)
  - UNIQUE (target_id) WHERE ((target_type = 'UTILITY_ABNORMAL_CONSUMPTION'::text) AND (status = 'PENDING'::text))

### `rfq_award_po_conversions`

- FKs: award_id→rfq_awards, award_id→rfq_awards, award_id→rfq_awards, award_id→rfq_awards, building_id→rfq_comparison_runs, building_id→rfq_comparison_runs, building_id→rfq_comparison_runs, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_awards, building_id→rfq_awards, building_id→rfq_vendor_invitations, building_id→rfq_awards, building_id→rfq_recommendations, building_id→rfq_recommendations, building_id→rfq_recommendations, building_id→rfq_recommendations, building_id→rfq_awards, building_id→rfq_comparison_runs, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→vendors, client_id→vendors, client_id→rfq_awards, client_id→rfq_awards, client_id→rfq_awards, client_id→rfq_comparison_runs, client_id→rfq_awards, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→rfq_recommendations, client_id→rfq_recommendations, client_id→rfq_recommendations, client_id→rfq_recommendations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_evidence, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_evidence, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, converted_by_user_id→users, evidence_id→rfq_comparison_evidence, evidence_id→rfq_comparison_evidence, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, po_readiness_id→purchase_order_readiness, purchase_order_id→purchase_orders, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, recommendation_id→rfq_recommendations, recommendation_id→rfq_recommendations, recommendation_id→rfq_recommendations, recommendation_id→rfq_recommendations, rfq_id→rfq_comparison_runs, rfq_id→rfq_comparison_runs, rfq_id→rfq_vendor_invitations, rfq_id→rfq_comparison_runs, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_recommendations, rfq_id→rfq_recommendations, rfq_id→rfq_recommendations, rfq_id→rfq_recommendations, rfq_id→rfq_awards, rfq_id→rfq_awards, rfq_id→rfq_awards, rfq_id→rfq_awards, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→rfq_comparison_runs, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→vendors, vendor_id→vendors
- Referenced by: rfq_award_po_line_provenance
- Indexes (8):
  - UNIQUE (award_id)
  - UNIQUE (award_id, idempotency_key)
  - UNIQUE (id, purchase_order_id)
  - UNIQUE (id)
  - UNIQUE (purchase_order_id)
  - (rfq_id, converted_at DESC)
  - UNIQUE (id, rfq_id, client_id, building_id)
  - (vendor_id, converted_at DESC)

### `rfq_award_po_line_provenance`

- FKs: conversion_id→rfq_award_po_conversions, conversion_id→rfq_award_po_conversions, conversion_id→rfq_award_po_conversions, purchase_order_id→rfq_award_po_conversions, purchase_order_id→purchase_orders, purchase_order_id→rfq_award_po_conversions, purchase_order_line_id→purchase_order_lines, quotation_line_id→vendor_quotation_lines, quotation_revision_id→vendor_quotation_revisions, rfq_id→rfqs, rfq_line_id→rfq_lines
- Referenced by: none
- Indexes (5):
  - (conversion_id, rfq_line_id)
  - UNIQUE (id)
  - UNIQUE (purchase_order_line_id)
  - UNIQUE (conversion_id, quotation_line_id)
  - UNIQUE (conversion_id, rfq_line_id)

### `rfq_awards`

- FKs: approval_id→procurement_approval_bindings, awarded_by_user_id→users, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfqs, building_id→rfqs, building_id→rfqs, building_id→rfq_vendor_invitations, building_id→rfq_comparison_runs, building_id→rfq_vendor_invitations, building_id→rfq_comparison_runs, building_id→rfq_comparison_runs, building_id→rfq_comparison_runs, building_id→rfq_recommendations, building_id→rfq_recommendations, building_id→rfq_recommendations, building_id→rfq_recommendations, building_id→rfq_vendor_invitations, client_id→rfq_recommendations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→vendors, client_id→vendors, client_id→rfqs, client_id→rfqs, client_id→rfqs, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→rfq_recommendations, client_id→rfq_recommendations, client_id→rfq_recommendations, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_evidence, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_evidence, comparison_run_id→rfq_comparison_runs, evidence_id→rfq_comparison_evidence, evidence_id→rfq_comparison_evidence, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, recommendation_id→rfq_recommendations, recommendation_id→rfq_recommendations, recommendation_id→rfq_recommendations, recommendation_id→rfq_recommendations, rfq_id→rfq_recommendations, rfq_id→rfq_recommendations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_comparison_runs, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfqs, rfq_id→rfqs, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→rfq_comparison_runs, rfq_id→rfq_comparison_runs, rfq_id→rfq_comparison_runs, rfq_id→rfqs, rfq_id→rfq_vendor_invitations, rfq_id→rfq_recommendations, rfq_id→rfq_recommendations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→vendors, vendor_id→vendors, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations
- Referenced by: rfq_award_po_conversions
- Indexes (6):
  - (building_id, awarded_at DESC)
  - UNIQUE (recommendation_id)
  - UNIQUE (rfq_id)
  - UNIQUE (id)
  - UNIQUE (id, rfq_id, client_id, building_id)
  - (vendor_id, awarded_at DESC) WHERE (vendor_id IS NOT NULL)

### `rfq_comparison_evaluations`

- FKs: comparison_run_id→rfq_comparison_evidence, comparison_run_id→rfq_comparison_evidence, created_by_user_id→users, evidence_id→rfq_comparison_evidence, evidence_id→rfq_comparison_evidence, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, rfq_id→rfqs, updated_by_user_id→users, vendor_id→vendors
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - (comparison_run_id, created_at, id)
  - UNIQUE (comparison_run_id, evidence_id)

### `rfq_comparison_evidence`

- FKs: building_id→rfq_comparison_runs, building_id→buildings, building_id→rfq_comparison_runs, building_id→rfq_comparison_runs, building_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→clients, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, invitation_id→rfq_vendor_invitations, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotations, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, rfq_id→rfqs, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→rfq_comparison_runs, rfq_id→rfq_comparison_runs, rfq_id→rfq_comparison_runs, rfq_id→rfq_comparison_runs, vendor_id→vendors
- Referenced by: rfq_award_po_conversions, rfq_awards, rfq_comparison_evaluations, rfq_comparison_evidence_attachments, rfq_comparison_lines, rfq_recommendations
- Indexes (5):
  - UNIQUE (id)
  - UNIQUE (comparison_run_id, quotation_revision_id)
  - (comparison_run_id, vendor_id)
  - UNIQUE (id, comparison_run_id)
  - UNIQUE (comparison_run_id, vendor_id)

### `rfq_comparison_evidence_attachments`

- FKs: comparison_run_id→rfq_comparison_evidence, comparison_run_id→rfq_comparison_evidence, document_id→documents, evidence_id→rfq_comparison_evidence, evidence_id→rfq_comparison_evidence, supporting_document_id→supporting_documents
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - (comparison_run_id, evidence_id)
  - UNIQUE (evidence_id, supporting_document_id)

### `rfq_comparison_lines`

- FKs: comparison_run_id→rfq_comparison_evidence, comparison_run_id→rfq_comparison_evidence, evidence_id→rfq_comparison_evidence, evidence_id→rfq_comparison_evidence, quotation_line_id→vendor_quotation_lines, reference_price_entry_id→price_catalog_entries, reference_uom_id→units_of_measure, required_uom_id→units_of_measure, rfq_id→rfqs, rfq_line_id→rfq_lines
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - (comparison_run_id, rfq_line_number_snapshot, evidence_id)
  - UNIQUE (evidence_id, rfq_line_id)

### `rfq_comparison_runs`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, rfq_id→rfqs
- Referenced by: rfq_award_po_conversions, rfq_awards, rfq_comparison_evidence, rfq_recommendations
- Indexes (4):
  - UNIQUE (rfq_id, idempotency_key)
  - UNIQUE (id)
  - (rfq_id, snapshot_at DESC, id DESC)
  - UNIQUE (id, rfq_id, client_id, building_id)

### `rfq_lines`

- FKs: building_id→service_requests, building_id→material_requests, building_id→rfqs, building_id→rfqs, building_id→rfqs, building_id→rfqs, building_id→material_requests, building_id→service_requests, building_id→service_requests, building_id→service_requests, building_id→material_requests, building_id→material_requests, building_id→rfqs, client_id→material_requests, client_id→service_requests, client_id→service_requests, client_id→service_requests, client_id→service_requests, client_id→service_catalog, client_id→service_catalog, client_id→rfqs, client_id→rfqs, client_id→rfqs, client_id→rfqs, client_id→rfqs, client_id→material_requests, client_id→material_requests, client_id→material_requests, created_by_user_id→users, material_request_id→material_requests, material_request_id→material_requests, material_request_id→material_requests, material_request_id→material_requests, purchase_request_id→service_requests, purchase_request_id→material_requests, purchase_request_id→rfqs, purchase_request_id→service_requests, purchase_request_id→service_requests, purchase_request_id→material_requests, purchase_request_id→material_requests, purchase_request_id→service_requests, purchase_request_id→material_requests, purchase_request_id→rfqs, purchase_request_id→rfqs, purchase_request_id→rfqs, purchase_request_id→rfqs, rfq_id→rfqs, rfq_id→rfqs, rfq_id→rfqs, rfq_id→rfqs, rfq_id→rfqs, service_request_id→service_requests, service_request_id→service_requests, service_request_id→service_requests, service_request_id→service_requests, source_item_id→inventory_items, source_mode→rfqs, source_mode→rfqs, source_mode→rfqs, source_mode→rfqs, source_mode→rfqs, source_service_id→service_catalog, source_service_id→service_catalog, source_uom_id→units_of_measure
- Referenced by: rfq_award_po_line_provenance, rfq_comparison_lines, vendor_quotation_lines
- Indexes (8):
  - UNIQUE (material_request_id) WHERE ((material_request_id IS NOT NULL) AND (source_claim_status = 'ACTIVE'::text))
  - UNIQUE (id)
  - UNIQUE (id, rfq_id)
  - (rfq_id, line_number)
  - UNIQUE (rfq_id, line_number)
  - (client_id, building_id, source_mode)
  - UNIQUE (service_request_id) WHERE ((service_request_id IS NOT NULL) AND (source_claim_status = 'ACTIVE'::text))
  - (source_service_id) WHERE (source_service_id IS NOT NULL)

### `rfq_recommendations`

- FKs: building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_comparison_runs, building_id→rfq_comparison_runs, building_id→rfqs, building_id→rfqs, building_id→rfqs, building_id→rfq_vendor_invitations, building_id→rfq_comparison_runs, building_id→rfq_vendor_invitations, building_id→rfq_comparison_runs, client_id→rfq_vendor_invitations, client_id→vendors, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→rfq_comparison_runs, client_id→rfqs, client_id→rfqs, client_id→rfqs, client_id→vendors, comparison_run_id→rfq_comparison_evidence, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_runs, comparison_run_id→rfq_comparison_evidence, created_by_user_id→users, evidence_id→rfq_comparison_evidence, evidence_id→rfq_comparison_evidence, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, rfq_id→rfqs, rfq_id→rfqs, rfq_id→rfqs, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_comparison_runs, rfq_id→rfq_comparison_runs, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→rfq_comparison_runs, rfq_id→rfq_comparison_runs, vendor_id→vendors, vendor_id→vendors, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations
- Referenced by: procurement_approval_bindings, rfq_award_po_conversions, rfq_awards
- Indexes (5):
  - (building_id, status, created_at DESC)
  - (comparison_run_id, created_at DESC)
  - UNIQUE (rfq_id)
  - UNIQUE (id)
  - UNIQUE (id, rfq_id, client_id, building_id)

### `rfq_vendor_access_sessions`

- FKs: building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations
- Referenced by: vendor_quotation_lines, vendor_quotation_revisions, vendor_quotations
- Indexes (7):
  - UNIQUE (id)
  - UNIQUE (invitation_id) WHERE (status = 'ACTIVE'::text)
  - (expires_at, status) WHERE (status = 'ACTIVE'::text)
  - (invitation_id, status)
  - UNIQUE (id, invitation_id, rfq_id, vendor_id, client_id, building_id)
  - UNIQUE (session_token_hash)
  - (vendor_id, status)

### `rfq_vendor_invitations`

- FKs: building_id→rfqs, building_id→rfqs, building_id→rfqs, client_id→vendors, client_id→vendors, client_id→vendors, client_id→vendors, client_id→rfqs, client_id→rfqs, client_id→rfqs, contact_source_id→vendors, contact_source_id→vendors, created_by_user_id→users, revoked_by_user_id→users, rfq_id→rfqs, rfq_id→rfqs, rfq_id→rfqs, vendor_id→vendors, vendor_id→vendors
- Referenced by: rfq_award_po_conversions, rfq_awards, rfq_comparison_evidence, rfq_recommendations, rfq_vendor_access_sessions, vendor_quotations
- Indexes (10):
  - UNIQUE (rfq_id, vendor_id) WHERE (status = ANY (ARRAY['INVITED'::text, 'ACCEPTED'::text, 'QUOTATION_SUBMITTED'::text]))
  - UNIQUE (rfq_id, vendor_id, attempt_number)
  - (building_id, status, created_at DESC)
  - (token_expires_at, status) WHERE (status = ANY (ARRAY['INVITED'::text, 'ACCEPTED'::text]))
  - UNIQUE (client_id, idempotency_key)
  - UNIQUE (id)
  - (rfq_id, status, created_at DESC)
  - UNIQUE (id, rfq_id, vendor_id, client_id, building_id)
  - UNIQUE (token_hash)
  - (vendor_id, status, created_at DESC)

### `rfqs`

- FKs: building_id→purchase_requests, building_id→purchase_requests, building_id→purchase_requests, cancelled_by_user_id→users, client_id→purchase_requests, client_id→purchase_requests, client_id→purchase_requests, closed_by_user_id→users, created_by_user_id→users, opened_by_user_id→users, purchase_request_id→purchase_requests, purchase_request_id→purchase_requests, purchase_request_id→purchase_requests
- Referenced by: procurement_approval_bindings, rfq_award_po_line_provenance, rfq_awards, rfq_comparison_evaluations, rfq_comparison_evidence, rfq_comparison_lines, rfq_comparison_runs, rfq_lines, rfq_recommendations, rfq_vendor_invitations
- Indexes (9):
  - (building_id, status, created_at DESC)
  - UNIQUE (client_id, idempotency_key)
  - UNIQUE (client_id, rfq_number)
  - (client_id, status, created_at DESC)
  - UNIQUE (id)
  - (purchase_request_id, status, created_at DESC)
  - UNIQUE (id, source_mode, client_id, building_id, purchase_request_id)
  - (source_mode, status, created_at DESC)
  - UNIQUE (id, client_id, building_id)

### `role_permission_assignments`

Role→permission grants.

- FKs: permission_id→permissions, role_id→roles
- Referenced by: none
- Indexes (4):
  - UNIQUE (role_id, permission_id) WHERE (status = 'ACTIVE'::text)
  - (permission_id)
  - UNIQUE (id)
  - (role_id)

### `roles`

Role definitions.

- FKs: none
- Referenced by: role_permission_assignments, user_role_assignments
- Indexes (2):
  - UNIQUE (code)
  - UNIQUE (id)

### `room_types`

- FKs: client_id→clients
- Referenced by: rooms
- Indexes (4):
  - UNIQUE (client_id, code)
  - (client_id)
  - UNIQUE (id)
  - (status)

### `rooms`

- FKs: area_id→areas, room_type_id→room_types
- Referenced by: cleaning_areas, handyman_arrival_location_identifiers, handyman_arrival_verification_results, handyman_execution_scopes, handyman_permit_readiness, handyman_unit_access_readiness, housekeeping_finding_links, incidents, patrol_route_points, permit_work_contexts, public_area_inspection_bindings, security_posts, spaces, toilet_inspection_bindings
- Indexes (5):
  - UNIQUE (area_id, code)
  - (area_id)
  - UNIQUE (id)
  - (room_type_id)
  - (status)

### `saas_billing_accounts`

- FKs: currency_code→currencies, customer_id→clients
- Referenced by: saas_invoices, saas_payment_allocations, saas_payment_records
- Indexes (3):
  - (customer_id)
  - UNIQUE (customer_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)

### `saas_invoice_lines`

- FKs: currency_code→currencies, invoice_id→saas_invoices
- Referenced by: none
- Indexes (2):
  - (invoice_id)
  - UNIQUE (id)

### `saas_invoice_number_sequences`

- FKs: none
- Referenced by: none
- Indexes (1):
  - UNIQUE (year)

### `saas_invoices`

- FKs: billing_account_id→saas_billing_accounts, currency_code→currencies, customer_id→clients, subscription_id→subscriptions
- Referenced by: saas_invoice_lines, saas_payment_allocations
- Indexes (7):
  - (billing_account_id)
  - (customer_id)
  - UNIQUE (number)
  - (period_start, period_end)
  - UNIQUE (id)
  - (status)
  - (subscription_id)

### `saas_packages`

- FKs: product_id→saas_products
- Referenced by: package_features, package_limits, saas_price_items, subscriptions
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (product_id, code)
  - (product_id, created_at DESC)

### `saas_payment_allocations`

- FKs: billing_account_id→saas_billing_accounts, currency_code→currencies, customer_id→clients, invoice_id→saas_invoices, payment_id→saas_payment_records
- Referenced by: none
- Indexes (5):
  - (customer_id)
  - (invoice_id)
  - (payment_id)
  - UNIQUE (payment_id, invoice_id)
  - UNIQUE (id)

### `saas_payment_provider_references`

- FKs: payment_id→saas_payment_records
- Referenced by: none
- Indexes (3):
  - (provider_type, external_reference)
  - (payment_id)
  - UNIQUE (id)

### `saas_payment_records`

- FKs: billing_account_id→saas_billing_accounts, currency_code→currencies, customer_id→clients
- Referenced by: saas_payment_allocations, saas_payment_provider_references
- Indexes (6):
  - (billing_account_id)
  - (customer_id)
  - UNIQUE (id)
  - UNIQUE (provider_type, provider_reference)
  - (received_at DESC)
  - (status)

### `saas_price_items`

- FKs: currency_code→currencies, package_id→saas_packages, pricebook_version_id→saas_pricebook_versions, product_id→saas_products
- Referenced by: none
- Indexes (3):
  - UNIQUE (id)
  - (pricebook_version_id)
  - UNIQUE (pricebook_version_id, product_id, COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid), billing_cycle)

### `saas_pricebook_versions`

- FKs: pricebook_id→saas_pricebooks, published_by_user_id→users
- Referenced by: saas_price_items, subscriptions
- Indexes (4):
  - UNIQUE (pricebook_id, version_number)
  - UNIQUE (id)
  - (pricebook_id, version_number DESC)
  - UNIQUE (pricebook_id) WHERE (status = 'PUBLISHED'::text)

### `saas_pricebooks`

- FKs: currency_code→currencies
- Referenced by: saas_pricebook_versions
- Indexes (2):
  - UNIQUE (code)
  - UNIQUE (id)

### `saas_products`

- FKs: none
- Referenced by: product_add_ons, saas_packages, saas_price_items, subscriptions
- Indexes (2):
  - UNIQUE (code)
  - UNIQUE (id)

### `saas_provisioning_runs`

- FKs: customer_id→clients
- Referenced by: none
- Indexes (4):
  - (created_at DESC)
  - (customer_id)
  - UNIQUE (id)
  - (status)

### `saas_subscription_add_ons`

- FKs: add_on_id→product_add_ons, subscription_id→subscriptions
- Referenced by: none
- Indexes (4):
  - UNIQUE (subscription_id, add_on_id) WHERE (status = 'ACTIVE'::text)
  - (add_on_id)
  - UNIQUE (id)
  - (subscription_id, status)

### `saas_usage_aggregations`

- FKs: customer_id→clients, meter_key→saas_usage_meters
- Referenced by: none
- Indexes (3):
  - (customer_id, meter_key)
  - UNIQUE (id)
  - UNIQUE (customer_id, meter_key, scope, period_start, period_end)

### `saas_usage_meters`

- FKs: none
- Referenced by: saas_usage_aggregations, saas_usage_records
- Indexes (2):
  - UNIQUE (meter_key)
  - UNIQUE (id)

### `saas_usage_records`

- FKs: building_id→properties, customer_id→clients, meter_key→saas_usage_meters, recorded_by_user_id→users
- Referenced by: none
- Indexes (4):
  - (building_id)
  - (customer_id, meter_key, scope, period_start)
  - UNIQUE (customer_id, meter_key, scope, period_start, source_reference)
  - UNIQUE (id)

### `safety_inspection_bindings`

- FKs: building_id→buildings, client_id→clients, schedule_definition_id→schedule_definitions
- Referenced by: none
- Indexes (5):
  - (building_id, status)
  - (client_id, status)
  - UNIQUE (id)
  - UNIQUE (schedule_definition_id) WHERE (status = 'ACTIVE'::text)
  - (schedule_definition_id, status)

### `schedule_definitions`

- FKs: building_id→buildings, client_id→clients
- Referenced by: cleaning_schedule_bindings, generated_tasks, maintenance_bindings, patrol_schedule_bindings, safety_inspection_bindings, schedule_recurrence, utility_reading_dues
- Indexes (5):
  - UNIQUE (client_id, target_type, target_id, building_id, status, code)
  - UNIQUE (id)
  - (building_id)
  - (client_id, status)
  - (target_type, target_id)

### `schedule_recurrence`

- FKs: schedule_definition_id→schedule_definitions
- Referenced by: none
- Indexes (3):
  - UNIQUE (schedule_definition_id)
  - UNIQUE (id)
  - (schedule_definition_id, status)

### `schema_foundation`

- FKs: none
- Referenced by: none
- Indexes (1):
  - UNIQUE (id)

### `schema_migrations`

- FKs: none
- Referenced by: none
- Indexes (1):
  - UNIQUE (id)

### `security_finding_links`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, finding_id→findings, patrol_route_id→patrol_routes, start_security_post_id→security_posts
- Referenced by: none
- Indexes (7):
  - (building_id)
  - UNIQUE (finding_id)
  - (finding_id)
  - (patrol_route_id)
  - UNIQUE (id)
  - (start_security_post_id)
  - UNIQUE (source_type, source_id)

### `security_incident_readiness`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, evidence_requirement_id→evidence_requirements, responsible_team_id→teams, responsible_workforce_id→workforce_profiles, security_post_id→security_posts
- Referenced by: none
- Indexes (7):
  - UNIQUE (building_id, security_post_id, category) WHERE (status = 'ACTIVE'::text)
  - (building_id, status)
  - (category, readiness_status)
  - UNIQUE (id)
  - (security_post_id)
  - (responsible_team_id)
  - (responsible_workforce_id)

### `security_key_custody`

- FKs: issued_by_user_id→users, issued_to_workforce_id→workforce_profiles, key_id→security_keys, returned_to_user_id→users
- Referenced by: none
- Indexes (4):
  - (key_id, created_at DESC)
  - (key_id, issued_at DESC) WHERE (returned_at IS NULL)
  - UNIQUE (id)
  - (issued_to_workforce_id)

### `security_keys`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, functional_location_id→functional_locations, security_post_id→security_posts
- Referenced by: security_key_custody
- Indexes (5):
  - UNIQUE (building_id, code)
  - (building_id, status)
  - (functional_location_id)
  - UNIQUE (id)
  - (security_post_id)

### `security_logbook_entries`

- FKs: building_id→buildings, client_id→clients, shift_handover_id→shift_handovers, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (5):
  - (building_id, recorded_at DESC)
  - (shift_handover_id)
  - UNIQUE (id)
  - (status)
  - (workforce_profile_id)

### `security_lost_found`

- FKs: building_id→buildings, client_id→clients, found_by_user_id→users, functional_location_id→functional_locations, security_post_id→security_posts
- Referenced by: security_lost_found_history
- Indexes (6):
  - UNIQUE (building_id, item_code)
  - (building_id, custody_status)
  - (building_id, found_at DESC)
  - (functional_location_id)
  - UNIQUE (id)
  - (security_post_id)

### `security_lost_found_history`

- FKs: lost_found_id→security_lost_found, returned_by_user_id→users, verified_by_user_id→users
- Referenced by: none
- Indexes (3):
  - (event_type)
  - UNIQUE (id)
  - (lost_found_id, occurred_at)

### `security_posts`

- FKs: area_id→areas, building_id→buildings, client_id→clients, floor_id→floors, functional_location_id→functional_locations, room_id→rooms, space_id→spaces
- Referenced by: operational_incidents, patrol_checklist_bindings, patrol_routes, patrol_schedule_bindings, security_finding_links, security_incident_readiness, security_keys, security_lost_found, security_shift_handover_bindings, security_visitor_bindings, workforce_shift_assignments
- Indexes (9):
  - (area_id)
  - UNIQUE (building_id, code)
  - (building_id, status)
  - (client_id, status)
  - (floor_id)
  - (functional_location_id)
  - UNIQUE (id)
  - (room_id)
  - (space_id)

### `security_shift_handover_bindings`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, patrol_route_id→patrol_routes, shift_handover_id→shift_handovers, start_security_post_id→security_posts
- Referenced by: none
- Indexes (6):
  - UNIQUE (shift_handover_id) WHERE (status = 'ACTIVE'::text)
  - (building_id, status)
  - (shift_handover_id)
  - (patrol_route_id)
  - UNIQUE (id)
  - (start_security_post_id)

### `security_visitor_bindings`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, security_post_id→security_posts, security_workforce_id→workforce_profiles
- Referenced by: none
- Indexes (6):
  - UNIQUE (building_id, external_visit_reference) WHERE (status = 'ACTIVE'::text)
  - (building_id, status)
  - (external_visit_reference)
  - (security_post_id)
  - (security_workforce_id)
  - UNIQUE (id)

### `service_catalog`

- FKs: client_id→clients, created_by_user_id→users
- Referenced by: handyman_common_material_profiles, handyman_discipline_service_associations, handyman_request_diagnoses, handyman_service_requests, handyman_service_variants, price_catalog_entries, purchase_order_lines, rfq_lines, service_requests, vendor_capabilities, vendor_quotation_lines, vendor_selection_readiness
- Indexes (6):
  - (client_id, category, status)
  - (client_id, code)
  - UNIQUE (client_id, code)
  - (client_id, status)
  - UNIQUE (id, client_id)
  - UNIQUE (id)

### `service_charge_readiness`

- FKs: building_id→buildings, client_id→clients, evaluated_by_user_id→users, space_id→spaces, tenant_charge_id→tenant_charges, tenant_company_id→tenant_companies
- Referenced by: service_charge_readiness_history
- Indexes (7):
  - (building_id, effective_from DESC)
  - (tenant_charge_id)
  - UNIQUE (tenant_company_id, building_id, space_id, service_charge_type, effective_from, effective_to)
  - UNIQUE (id)
  - (space_id, effective_from DESC)
  - (readiness_status, effective_from DESC)
  - (tenant_company_id, effective_from DESC)

### `service_charge_readiness_history`

- FKs: changed_by_user_id→users, service_charge_readiness_id→service_charge_readiness, tenant_charge_id→tenant_charges
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - (service_charge_readiness_id, changed_at)

### `service_requests`

- FKs: building_id→buildings, client_id→service_catalog, client_id→service_catalog, client_id→clients, functional_location_id→functional_locations, purchase_request_id→purchase_requests, requested_by_user_id→users, service_catalog_id→service_catalog, service_catalog_id→service_catalog, vendor_id→vendors
- Referenced by: procurement_approval_bindings, purchase_order_lines, purchase_order_readiness, purchase_orders, receivings, rfq_lines, vendor_selection_readiness, vendor_service_costs, work_order_procurement_bindings
- Indexes (8):
  - (building_id, status, created_at)
  - (client_id, status)
  - (functional_location_id, status)
  - UNIQUE (id)
  - (purchase_request_id, status)
  - UNIQUE (id, client_id, building_id, purchase_request_id)
  - (service_catalog_id) WHERE (service_catalog_id IS NOT NULL)
  - (service_type, status)

### `shift_handovers`

- FKs: acknowledged_by_user_id→users, building_id→buildings, client_id→clients, incoming_shift_id→shifts, outgoing_shift_id→shifts, prepared_by_user_id→users
- Referenced by: security_logbook_entries, security_shift_handover_bindings
- Indexes (5):
  - (building_id, handover_date DESC)
  - (incoming_shift_id)
  - (outgoing_shift_id)
  - UNIQUE (id)
  - (status)

### `shifts`

- FKs: building_id→buildings, client_id→clients
- Referenced by: attendance_records, shift_handovers, workforce_shift_assignments
- Indexes (5):
  - UNIQUE (building_id, code)
  - (building_id)
  - (client_id)
  - UNIQUE (id)
  - (status)

### `skills`

- FKs: client_id→clients
- Referenced by: workforce_skill_assignments
- Indexes (5):
  - (category)
  - UNIQUE (client_id, code)
  - (client_id)
  - UNIQUE (id)
  - (status)

### `sla_clock_pause_intervals`

- FKs: pause_actor_user_id→users, resume_actor_user_id→users, sla_clock_id→sla_clocks
- Referenced by: none
- Indexes (3):
  - UNIQUE (sla_clock_id) WHERE (resumed_at IS NULL)
  - (sla_clock_id, paused_at)
  - UNIQUE (id)

### `sla_clocks`

Running/satisfied/breached SLA clocks (breach dispatcher target).

- FKs: applied_sla_id→applied_slas
- Referenced by: sla_clock_pause_intervals, sla_escalation_actions
- Indexes (4):
  - UNIQUE (applied_sla_id, clock_type)
  - (status, breached_at) WHERE ((status = 'RUNNING'::text) AND (breached_at IS NULL))
  - UNIQUE (id)
  - (status, started_at) WHERE (status = 'RUNNING'::text)

### `sla_definitions`

- FKs: building_id→buildings, client_id→clients
- Referenced by: applied_slas
- Indexes (4):
  - (building_id, status, effective_from) WHERE (building_id IS NOT NULL)
  - UNIQUE (client_id, code)
  - (client_id, status, operational_type, effective_from)
  - UNIQUE (id)

### `sla_escalation_actions`

- FKs: applied_sla_id→applied_slas, building_id→buildings, client_id→clients, escalation_level_id→sla_escalation_levels, policy_id→sla_escalation_policies, sla_clock_id→sla_clocks, template_key→notification_templates, work_order_id→work_orders
- Referenced by: none
- Indexes (5):
  - (client_id, created_at DESC)
  - UNIQUE (sla_clock_id, escalation_level_id)
  - (status, due_at) WHERE (status = 'PENDING'::text)
  - UNIQUE (id)
  - (work_order_id, level)

### `sla_escalation_levels`

- FKs: policy_id→sla_escalation_policies, template_key→notification_templates
- Referenced by: sla_escalation_actions
- Indexes (3):
  - UNIQUE (id)
  - UNIQUE (policy_id, level)
  - (policy_id, level)

### `sla_escalation_policies`

- FKs: building_id→buildings, client_id→clients
- Referenced by: sla_escalation_actions, sla_escalation_levels
- Indexes (4):
  - (client_id, building_id, operational_type, clock_type, status)
  - UNIQUE (client_id, code)
  - (client_id, status, effective_from)
  - UNIQUE (id)

### `source_forms`

- FKs: client_id→clients
- Referenced by: form_templates
- Indexes (4):
  - UNIQUE (client_id, code)
  - (client_id)
  - (client_id, status)
  - UNIQUE (id)

### `spaces`

Leasable spaces/units.

- FKs: room_id→rooms
- Referenced by: cleaning_areas, functional_locations, handyman_arrival_location_identifiers, handyman_arrival_verification_results, handyman_channel_attributions, handyman_execution_scopes, handyman_handoff_exchanges, handyman_permit_readiness, handyman_service_requests, handyman_unit_access_readiness, incidents, patrol_route_points, security_posts, service_charge_readiness, tenant_approval_bindings, tenant_charges, tenant_complaints, tenant_contractor_relationships, tenant_invoices, tenant_service_requests, tenant_space_relationships, tenant_utility_requests, utility_bills, utility_meter_tenant_assignments, utility_meters
- Indexes (4):
  - UNIQUE (id)
  - UNIQUE (room_id, code)
  - (room_id)
  - (status)

### `subscriptions`

- FKs: client_id→clients, currency_code→currencies, package_id→saas_packages, pricebook_version_id→saas_pricebook_versions, product_id→saas_products
- Referenced by: licenses, module_entitlements, saas_invoices, saas_subscription_add_ons
- Indexes (7):
  - (client_id)
  - UNIQUE (code)
  - (package_id)
  - UNIQUE (id)
  - (pricebook_version_id)
  - (product_id)
  - (status)

### `supervisor_inspections`

- FKs: building_id→buildings, cleaning_area_id→cleaning_areas, client_id→clients, review_id→reviews, supervisor_user_id→users
- Referenced by: none
- Indexes (7):
  - (cleaning_area_id, status)
  - (building_id, status)
  - UNIQUE (id)
  - (review_id)
  - (supervisor_user_id, status)
  - (target_type, target_id)
  - UNIQUE (target_type, target_id) WHERE (status = 'PENDING'::text)

### `supporting_documents`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, document_id→documents
- Referenced by: rfq_comparison_evidence_attachments
- Indexes (7):
  - (building_id, context_type)
  - (client_id)
  - (context_type)
  - UNIQUE (document_id)
  - (document_id)
  - (parent_type, parent_id)
  - UNIQUE (id)

### `task_assignments`

- FKs: assigned_by_user_id→users, task_id→generated_tasks, team_id→teams, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (4):
  - (team_id, status)
  - (workforce_profile_id, status)
  - UNIQUE (task_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)

### `teams`

- FKs: department_id→departments
- Referenced by: checklist_executions, finding_assignments, form_instances, security_incident_readiness, task_assignments, work_order_assignments, workforce_profiles
- Indexes (3):
  - UNIQUE (department_id, code)
  - (department_id)
  - UNIQUE (id)

### `tenant_approval_bindings`

- FKs: approver_user_id→users, building_id→buildings, client_id→clients, complaint_id→tenant_complaints, created_by_user_id→users, service_request_id→tenant_service_requests, tenant_company_id→tenant_companies, utility_calculation_id→utility_calculations, utility_meter_id→utility_meters, utility_request_id→tenant_utility_requests, utility_space_id→spaces, utility_tariff_id→utility_calculation_bases, utility_uom_id→units_of_measure
- Referenced by: utility_bills
- Indexes (9):
  - (approver_user_id, status, created_at)
  - UNIQUE (id)
  - (building_id, status, created_at)
  - UNIQUE (complaint_id, approval_type, approver_user_id) WHERE ((status = 'PENDING'::text) AND (complaint_id IS NOT NULL))
  - UNIQUE (service_request_id, approval_type, approver_user_id) WHERE ((status = 'PENDING'::text) AND (service_request_id IS NOT NULL))
  - (tenant_company_id, status, created_at)
  - (utility_calculation_id, status, created_at)
  - UNIQUE (utility_calculation_id, approval_type, approver_user_id) WHERE ((status = 'PENDING'::text) AND (utility_calculation_id IS NOT NULL))
  - UNIQUE (utility_request_id, approval_type, approver_user_id) WHERE ((status = 'PENDING'::text) AND (utility_request_id IS NOT NULL))

### `tenant_building_contexts`

- FKs: building_id→buildings, tenant_company_id→tenant_companies
- Referenced by: handyman_handoff_exchanges
- Indexes (4):
  - UNIQUE (tenant_company_id, building_id) WHERE (status = 'ACTIVE'::text)
  - (building_id, status)
  - (tenant_company_id, status)
  - UNIQUE (id)

### `tenant_charge_history`

- FKs: changed_by_user_id→users, tenant_charge_id→tenant_charges
- Referenced by: none
- Indexes (2):
  - (tenant_charge_id, changed_at)
  - UNIQUE (id)

### `tenant_charges`

Tenant charge ledger rows.

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, created_by_user_id→users, space_id→spaces, tenant_company_id→tenant_companies
- Referenced by: service_charge_readiness, service_charge_readiness_history, tenant_charge_history, tenant_invoice_lines
- Indexes (6):
  - (building_id, charge_date DESC)
  - (client_id, charge_date DESC)
  - UNIQUE (id)
  - (space_id, charge_date DESC)
  - (tenant_company_id, charge_date DESC)
  - (charge_type, status, charge_date DESC)

### `tenant_communications`

- FKs: building_id→buildings, client_id→clients, complaint_id→tenant_complaints, document_id→tenant_documents, recipient_tenant_pic_id→tenant_pics, recipient_user_id→users, sender_user_id→users, service_request_id→tenant_service_requests, tenant_company_id→tenant_companies, utility_request_id→tenant_utility_requests
- Referenced by: none
- Indexes (6):
  - (building_id, status, created_at)
  - UNIQUE (id)
  - (recipient_tenant_pic_id, status, created_at)
  - (recipient_user_id, status, created_at)
  - (related_type, created_at)
  - (tenant_company_id, status, created_at)

### `tenant_companies`

Tenant companies occupying spaces.

- FKs: client_id→clients
- Referenced by: handyman_channel_attributions, handyman_execution_scopes, handyman_handoff_exchanges, handyman_quotation_decisions, handyman_service_requests, handyman_visit_appointments, invoice_payment_status, payment_receipts, service_charge_readiness, tenant_approval_bindings, tenant_building_contexts, tenant_charges, tenant_communications, tenant_complaints, tenant_contractor_relationships, tenant_documents, tenant_invoices, tenant_pics, tenant_service_requests, tenant_space_relationships, tenant_utility_requests, utility_abnormal_consumptions, utility_bills, utility_calculations, utility_meter_consumptions, utility_meter_readings, utility_meter_tenant_assignments
- Indexes (4):
  - UNIQUE (client_id, tenant_code)
  - (client_id, lower(tenant_name))
  - (client_id, status)
  - UNIQUE (id)

### `tenant_complaints`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, finding_id→findings, space_id→spaces, tenant_company_id→tenant_companies, tenant_pic_id→tenant_pics, work_order_id→work_orders
- Referenced by: tenant_approval_bindings, tenant_communications
- Indexes (8):
  - (building_id, status, reported_at)
  - UNIQUE (finding_id)
  - UNIQUE (client_id, complaint_number)
  - (tenant_pic_id, status)
  - UNIQUE (id)
  - (space_id, status)
  - (tenant_company_id, status, reported_at)
  - UNIQUE (work_order_id)

### `tenant_contractor_relationships`

- FKs: building_id→buildings, client_id→clients, contractor_vendor_id→vendors, space_id→spaces, tenant_company_id→tenant_companies
- Referenced by: permits
- Indexes (6):
  - UNIQUE (tenant_company_id, contractor_vendor_id, building_id, COALESCE(space_id, '00000000-0000-0000-0000-000000000000'::uuid), relationship_type) WHERE (status = 'ACTIVE'::text)
  - (building_id, status, effective_from)
  - UNIQUE (id)
  - (space_id, status)
  - (tenant_company_id, status, effective_from)
  - (contractor_vendor_id, status, effective_from)

### `tenant_documents`

- FKs: building_id→buildings, client_id→clients, tenant_company_id→tenant_companies
- Referenced by: tenant_communications
- Indexes (5):
  - UNIQUE (tenant_company_id, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid), document_type, document_number) WHERE (status = 'ACTIVE'::text)
  - (building_id, status, document_type)
  - (expiry_date, status)
  - UNIQUE (id)
  - (tenant_company_id, status, document_type)

### `tenant_invoice_history`

- FKs: changed_by_user_id→users, tenant_invoice_id→tenant_invoices
- Referenced by: none
- Indexes (2):
  - (tenant_invoice_id, changed_at)
  - UNIQUE (id)

### `tenant_invoice_lines`

- FKs: handyman_charge_line_id→handyman_charge_lines, invoice_id→tenant_invoices, tenant_charge_id→tenant_charges, utility_bill_id→utility_bills
- Referenced by: none
- Indexes (5):
  - UNIQUE (handyman_charge_line_id) WHERE (handyman_charge_line_id IS NOT NULL)
  - (invoice_id, created_at)
  - UNIQUE (id)
  - UNIQUE (tenant_charge_id)
  - UNIQUE (utility_bill_id)

### `tenant_invoices`

Tenant invoices (client-scoped numbering; Handyman-scope bound unique).

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, created_by_user_id→users, finalized_by_user_id→users, handyman_execution_scope_id→handyman_execution_scopes, space_id→spaces, tenant_company_id→tenant_companies
- Referenced by: invoice_payment_status, payment_receipts, tenant_invoice_history, tenant_invoice_lines
- Indexes (6):
  - (building_id, invoice_date DESC)
  - UNIQUE (handyman_execution_scope_id) WHERE (handyman_execution_scope_id IS NOT NULL)
  - UNIQUE (client_id, invoice_number)
  - UNIQUE (id)
  - (status, invoice_date DESC)
  - (tenant_company_id, invoice_date DESC)

### `tenant_pics`

- FKs: tenant_company_id→tenant_companies, user_id→users
- Referenced by: handyman_channel_attributions, handyman_execution_scopes, handyman_handoff_exchanges, handyman_quotation_decisions, handyman_service_requests, tenant_communications, tenant_complaints, tenant_service_requests, tenant_utility_requests
- Indexes (4):
  - (tenant_company_id, status)
  - UNIQUE (tenant_company_id, user_id) WHERE (user_id IS NOT NULL)
  - UNIQUE (id)
  - UNIQUE (tenant_company_id) WHERE is_primary

### `tenant_service_requests`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, space_id→spaces, tenant_company_id→tenant_companies, tenant_pic_id→tenant_pics, work_order_id→work_orders, work_request_id→work_requests
- Referenced by: tenant_approval_bindings, tenant_communications
- Indexes (8):
  - (building_id, status, requested_at)
  - UNIQUE (client_id, request_number)
  - (tenant_pic_id, status)
  - UNIQUE (id)
  - (space_id, status)
  - (tenant_company_id, status, requested_at)
  - UNIQUE (work_order_id)
  - UNIQUE (work_request_id)

### `tenant_space_relationships`

- FKs: building_id→buildings, space_id→spaces, tenant_company_id→tenant_companies
- Referenced by: handyman_handoff_exchanges
- Indexes (5):
  - UNIQUE (space_id) WHERE (status = 'ACTIVE'::text)
  - (building_id, status)
  - (tenant_company_id, status)
  - UNIQUE (id)
  - (space_id)

### `tenant_utility_requests`

- FKs: building_id→buildings, client_id→clients, space_id→spaces, tenant_company_id→tenant_companies, tenant_pic_id→tenant_pics, work_order_id→work_orders, work_request_id→work_requests
- Referenced by: tenant_approval_bindings, tenant_communications
- Indexes (8):
  - (building_id, status, requested_at)
  - UNIQUE (client_id, request_number)
  - UNIQUE (id)
  - (space_id, status)
  - (tenant_company_id, status, requested_at)
  - (utility_type, status)
  - UNIQUE (work_order_id)
  - UNIQUE (work_request_id)

### `toilet_inspection_bindings`

- FKs: building_id→buildings, checklist_template_id→checklist_templates, cleaning_area_id→cleaning_areas, client_id→clients, created_by_user_id→users, functional_location_id→functional_locations, room_id→rooms
- Referenced by: checklist_executions
- Indexes (8):
  - UNIQUE (cleaning_area_id, checklist_template_id) WHERE (status = 'ACTIVE'::text)
  - (cleaning_area_id, status)
  - (building_id, status)
  - (client_id, status)
  - (functional_location_id)
  - UNIQUE (id)
  - (room_id)
  - (checklist_template_id, status)

### `units_of_measure`

- FKs: client_id→clients
- Referenced by: building_utility_reconciliations, checklist_items, esg_baselines, esg_metric_definitions, esg_metric_values, esg_targets, esg_waste_records, form_fields, handyman_quotation_lines, inventory_items, inventory_material_reservations, inventory_stock_movements, inventory_work_order_material_usages, material_requests, meter_reading_bindings, price_catalog_entries, purchase_order_lines, receivings, rfq_comparison_lines, rfq_lines, tenant_approval_bindings, utility_abnormal_consumptions, utility_bills, utility_calculation_bases, utility_calculations, utility_meter_consumptions, utility_meter_readings, utility_meters, utility_type_uoms, vendor_quotation_lines
- Indexes (4):
  - UNIQUE (id)
  - UNIQUE (id, client_id)
  - UNIQUE (client_id, code)
  - (client_id, status)

### `user_building_assignments`

- FKs: assigned_by_user_id→users, building_id→buildings, user_id→users
- Referenced by: none
- Indexes (4):
  - (building_id)
  - UNIQUE (user_id, building_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (user_id)

### `user_credentials`

- FKs: user_id→users
- Referenced by: none
- Indexes (2):
  - UNIQUE (id)
  - UNIQUE (user_id)

### `user_invitations`

- FKs: accepted_by_user_id→users, invited_by_user_id→users
- Referenced by: none
- Indexes (4):
  - (email)
  - (expires_at)
  - UNIQUE (id)
  - UNIQUE (token_hash)

### `user_role_assignments`

User→role grants.

- FKs: role_id→roles, user_id→users
- Referenced by: none
- Indexes (4):
  - UNIQUE (user_id, role_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (role_id)
  - (user_id)

### `user_sessions`

Active user sessions.

- FKs: user_id→users
- Referenced by: none
- Indexes (4):
  - (expires_at)
  - UNIQUE (id)
  - UNIQUE (token_hash)
  - (user_id)

### `users`

User accounts.

- FKs: none
- Referenced by: acceptance_sign_offs, asset_failure_incidents, asset_history_events, assets, authentication_audit_events, basic_expense_history, basic_expenses, bast_documents, bast_finding_links, bast_reconciliation_quarantines, bast_submission_attempts, breakdown_bindings, building_utility_reconciliations, checklist_executions, checklist_item_responses, cleaning_schedule_bindings, client_fx_policies, cms_content, configuration_preview_contexts, configuration_version_transitions, configuration_version_validations, configuration_versions, consumable_readiness_checks, contractor_visitors, corrective_action_responsibilities, corrective_actions, delivery_couriers, document_versions, documents, engineering_checklist_bindings, engineering_finding_links, esg_baselines, esg_metric_definitions, esg_metric_values, esg_targets, esg_waste_records, evidence_submissions, expected_visitors, finding_assignments, finding_escalation_incidents, finding_rework_cycles, findings, form_instances, form_responses, fx_rate_events, fx_rates, generated_tasks, handover_documents, handyman_arrival_challenges, handyman_arrival_verification_results, handyman_bast_events, handyman_bm_fee_beneficiary_definitions, handyman_bm_fee_rule_definitions, handyman_bm_fee_term_definitions, handyman_building_geospatial_policies, handyman_care_property_grants, handyman_channel_attributions, handyman_charge_line_bases, handyman_charge_lines, handyman_chargeable_additional_work_events, handyman_chargeable_additional_works, handyman_commercial_agreement_events, handyman_commercial_agreement_versions, handyman_commercial_agreements, handyman_common_material_profiles, handyman_crew_leads, handyman_crew_memberships, handyman_customer_payment_events, handyman_customer_payments, handyman_customer_transaction_events, handyman_customer_transactions, handyman_defect_events, handyman_discipline_service_associations, handyman_entitlement_corrections, handyman_entitlement_facts, handyman_evidence_record_events, handyman_execution_scope_assignments, handyman_execution_scopes, handyman_handoff_exchanges, handyman_labor_pricing_basis_definitions, handyman_ledger_corrections, handyman_material_execution_events, handyman_material_pricing_basis_definitions, handyman_payment_allocations, handyman_permit_readiness, handyman_provider_contexts, handyman_qc_run_events, handyman_quotation_decisions, handyman_quotation_lines, handyman_quotation_versions, handyman_quotations, handyman_request_diagnoses, handyman_request_inspections, handyman_request_referrals, handyman_request_triage_decisions, handyman_scheduling_readiness, handyman_service_requests, handyman_service_variants, handyman_service_warranties, handyman_service_warranty_claim_events, handyman_service_warranty_claims, handyman_service_warranty_events, handyman_service_warranty_rework_events, handyman_service_warranty_reworks, handyman_settlement_command_keys, handyman_settlement_events, handyman_settlement_exceptions, handyman_settlement_inclusions, handyman_settlement_reconciliations, handyman_settlement_units, handyman_unit_access_readiness, handyman_visit_appointments, handyman_visit_attempts, handyman_work_crews, handyman_work_session_events, handyman_work_session_helper_presence, handyman_work_sessions, handyman_worker_contexts, host_confirmations, housekeeping_complaint_bindings, housekeeping_finding_links, immediate_actions, incidents, inspection_bindings, inventory_material_reservations, inventory_stock_adjustments, inventory_stock_movements, inventory_stock_transfers, inventory_work_order_material_usages, invoice_payment_status, invoice_payment_status_history, log_sheet_bindings, maintenance_bindings, material_requests, meter_reading_bindings, mobile_push_tokens, mobile_sync_idempotency, notification_email_deliveries, notification_escalations, notification_outbound_deliveries, notification_push_deliveries, notification_secure_links, notification_whatsapp_deliveries, notifications, operational_budget_source_bindings, operational_commitment_entries, operational_commitments, operational_events, operational_incidents, patrol_checklist_bindings, patrol_point_visits, patrol_schedule_bindings, payment_receipt_history, payment_receipts, permit_applications, permit_approval_bindings, permit_equipment, permit_safety_requirements, permit_validities, permit_work_contexts, permit_work_lifecycles, permit_workers, permits, platform_configurations, platform_support_sessions, price_catalog_entries, procurement_approval_bindings, public_area_inspection_bindings, purchase_order_history, purchase_order_line_history, purchase_order_lines, purchase_order_readiness, purchase_orders, purchase_requests, quality_audits, receivings, report_archives, request_idempotency_records, reviews, rfq_award_po_conversions, rfq_awards, rfq_comparison_evaluations, rfq_comparison_runs, rfq_lines, rfq_recommendations, rfq_vendor_invitations, rfqs, saas_pricebook_versions, saas_usage_records, security_finding_links, security_incident_readiness, security_key_custody, security_keys, security_lost_found, security_lost_found_history, security_shift_handover_bindings, security_visitor_bindings, service_catalog, service_charge_readiness, service_charge_readiness_history, service_requests, shift_handovers, sla_clock_pause_intervals, supervisor_inspections, supporting_documents, task_assignments, tenant_approval_bindings, tenant_charge_history, tenant_charges, tenant_communications, tenant_complaints, tenant_invoice_history, tenant_invoices, tenant_pics, tenant_service_requests, toilet_inspection_bindings, user_building_assignments, user_credentials, user_invitations, user_role_assignments, user_sessions, utility_abnormal_consumptions, utility_bill_history, utility_bills, utility_calculations, utility_meter_consumptions, utility_meter_ocr_candidates, utility_meter_readings, utility_operational_exceptions, utility_reading_dues, vendor_assignments, vendor_bast_bindings, vendor_checklist_bindings, vendor_completion_reports, vendor_invoice_history, vendor_invoices, vendor_rework_cycles, vendor_selection_readiness, vendor_service_cost_history, vendor_service_costs, vendor_service_reports, visit_check_ins, visitor_invitations, visitor_passes, visitor_photos, visitors, walk_in_visits, work_completion_documents, work_contract_history, work_contracts, work_order_actions, work_order_assignments, work_order_procurement_bindings, work_orders, work_permit_readiness, work_requests, workforce_profiles
- Indexes (3):
  - UNIQUE (email)
  - UNIQUE (id)
  - UNIQUE (whatsapp_phone) WHERE (whatsapp_phone IS NOT NULL)

### `utility_abnormal_consumptions`

- FKs: building_id→buildings, client_id→clients, consumption_id→utility_meter_consumptions, detected_by_user_id→users, finding_id→findings, meter_id→utility_meters, resolved_by_user_id→users, rule_id→utility_abnormality_rules, tenant_assignment_id→utility_meter_tenant_assignments, tenant_company_id→tenant_companies, uom_id→units_of_measure
- Referenced by: utility_operational_exceptions
- Indexes (8):
  - (building_id, period_end DESC)
  - (client_id, period_end DESC)
  - (finding_id)
  - (meter_id, period_end DESC)
  - UNIQUE (consumption_id, abnormality_type) WHERE (status = 'OPEN'::text)
  - UNIQUE (id)
  - (status, detected_at DESC)
  - (tenant_company_id, period_end DESC)

### `utility_abnormality_rules`

- FKs: client_id→clients
- Referenced by: utility_abnormal_consumptions
- Indexes (3):
  - (client_id, utility_type, status)
  - UNIQUE (id)
  - UNIQUE (client_id, utility_type, abnormality_type)

### `utility_bill_history`

- FKs: changed_by_user_id→users, utility_bill_id→utility_bills
- Referenced by: none
- Indexes (2):
  - (utility_bill_id, changed_at)
  - UNIQUE (id)

### `utility_bills`

- FKs: approval_id→tenant_approval_bindings, building_id→buildings, calculation_id→utility_calculations, client_id→clients, generated_by_user_id→users, meter_id→utility_meters, space_id→spaces, tenant_assignment_id→utility_meter_tenant_assignments, tenant_company_id→tenant_companies, uom_id→units_of_measure
- Referenced by: tenant_invoice_lines, utility_bill_history
- Indexes (9):
  - UNIQUE (approval_id)
  - (building_id, period_end DESC)
  - UNIQUE (calculation_id)
  - (client_id, period_end DESC)
  - UNIQUE (tenant_company_id, meter_id, period_start, period_end)
  - (meter_id, period_end DESC)
  - UNIQUE (id)
  - (tenant_company_id, period_end DESC)
  - (utility_type, status, period_end DESC)

### `utility_calculation_bases`

- FKs: building_id→buildings, client_id→clients, uom_id→units_of_measure
- Referenced by: tenant_approval_bindings, utility_calculations
- Indexes (4):
  - (client_id, utility_type, status, effective_from DESC)
  - UNIQUE (id)
  - (client_id, building_id, utility_type, tstzrange(effective_from, effective_to, '[)'::text)) WHERE ((status = 'ACTIVE'::text) AND (building_id IS NOT NULL))
  - (client_id, building_id, utility_type, uom_id, effective_from DESC) WHERE ((status = 'ACTIVE'::text) AND (building_id IS NOT NULL))

### `utility_calculations`

- FKs: building_id→buildings, calculated_by_user_id→users, calculation_basis_id→utility_calculation_bases, client_id→clients, consumption_id→utility_meter_consumptions, finalized_by_user_id→users, meter_id→utility_meters, supersedes_calculation_id→utility_calculations, tariff_id→utility_calculation_bases, tenant_assignment_id→utility_meter_tenant_assignments, tenant_company_id→tenant_companies, uom_id→units_of_measure
- Referenced by: tenant_approval_bindings, utility_bills, utility_calculations
- Indexes (6):
  - (building_id, period_end DESC)
  - (client_id, period_end DESC)
  - UNIQUE (consumption_id) WHERE (status <> 'SUPERSEDED'::text)
  - (meter_id, period_end DESC)
  - UNIQUE (id)
  - (tenant_company_id, period_end DESC)

### `utility_meter_consumptions`

- FKs: building_id→buildings, calculated_by_user_id→users, client_id→clients, current_reading_id→utility_meter_readings, meter_id→utility_meters, previous_reading_id→utility_meter_readings, tenant_assignment_id→utility_meter_tenant_assignments, tenant_company_id→tenant_companies, uom_id→units_of_measure
- Referenced by: utility_abnormal_consumptions, utility_calculations, utility_operational_exceptions
- Indexes (6):
  - (building_id, period_end DESC)
  - (client_id, period_end DESC)
  - UNIQUE (meter_id, current_reading_id)
  - (meter_id, period_end DESC)
  - UNIQUE (id)
  - (tenant_company_id, period_end DESC)

### `utility_meter_hierarchies`

- FKs: client_id→clients, main_meter_id→utility_meters, sub_meter_id→utility_meters
- Referenced by: none
- Indexes (5):
  - UNIQUE (sub_meter_id) WHERE (status = 'ACTIVE'::text)
  - (client_id, status)
  - (main_meter_id, status)
  - UNIQUE (id)
  - (sub_meter_id, status)

### `utility_meter_ocr_candidates`

- FKs: accepted_reading_id→utility_meter_readings, building_id→buildings, client_id→clients, created_by_user_id→users, evidence_id→evidence_submissions, meter_id→utility_meters, verified_by_user_id→users
- Referenced by: utility_operational_exceptions
- Indexes (4):
  - (building_id, status, created_at)
  - UNIQUE (evidence_id)
  - UNIQUE (id)
  - (meter_id, created_at DESC)

### `utility_meter_readings`

- FKs: building_id→buildings, client_id→clients, form_instance_id→form_instances, meter_id→utility_meters, meter_reading_binding_id→meter_reading_bindings, recorded_by_user_id→users, tenant_assignment_id→utility_meter_tenant_assignments, tenant_company_id→tenant_companies, uom_id→units_of_measure
- Referenced by: utility_meter_consumptions, utility_meter_ocr_candidates, utility_operational_exceptions, utility_reading_dues
- Indexes (7):
  - (building_id, reading_at DESC)
  - (client_id, reading_at DESC)
  - UNIQUE (form_instance_id) WHERE (form_instance_id IS NOT NULL)
  - (meter_id, reading_at DESC)
  - UNIQUE (meter_id, reading_at)
  - UNIQUE (id)
  - (tenant_company_id, reading_at DESC)

### `utility_meter_tenant_assignments`

- FKs: building_id→buildings, client_id→clients, meter_id→utility_meters, space_id→spaces, tenant_company_id→tenant_companies
- Referenced by: utility_abnormal_consumptions, utility_bills, utility_calculations, utility_meter_consumptions, utility_meter_readings
- Indexes (6):
  - UNIQUE (meter_id) WHERE (status = 'ACTIVE'::text)
  - (client_id, building_id, status)
  - (meter_id, status)
  - UNIQUE (id)
  - (space_id, status)
  - (tenant_company_id, status)

### `utility_meters`

- FKs: building_id→buildings, client_id→clients, functional_location_id→functional_locations, space_id→spaces, uom_id→units_of_measure
- Referenced by: tenant_approval_bindings, utility_abnormal_consumptions, utility_bills, utility_calculations, utility_meter_consumptions, utility_meter_hierarchies, utility_meter_ocr_candidates, utility_meter_readings, utility_meter_tenant_assignments, utility_operational_exceptions, utility_reading_dues
- Indexes (9):
  - (building_id, status)
  - UNIQUE (client_id, code)
  - (client_id, status)
  - (functional_location_id) WHERE (functional_location_id IS NOT NULL)
  - UNIQUE (id)
  - (building_id, purpose, status)
  - (space_id) WHERE (space_id IS NOT NULL)
  - (uom_id)
  - (utility_type, status)

### `utility_operational_exceptions`

- FKs: abnormal_consumption_id→utility_abnormal_consumptions, building_id→buildings, cancelled_by_user_id→users, client_id→clients, consumption_id→utility_meter_consumptions, detected_by_user_id→users, meter_id→utility_meters, meter_reading_id→utility_meter_readings, ocr_candidate_id→utility_meter_ocr_candidates, reading_due_id→utility_reading_dues, reconciliation_id→building_utility_reconciliations, replacement_meter_reading_id→utility_meter_readings, resolved_by_user_id→users, reviewer_user_id→users
- Referenced by: none
- Indexes (8):
  - UNIQUE (exception_type, COALESCE(reconciliation_id, abnormal_consumption_id, ocr_candidate_id, consumption_id, reading_due_id, meter_reading_id, meter_id)) WHERE (status = ANY (ARRAY['OPEN'::text, 'UNDER_REVIEW'::text]))
  - (building_id, status, detected_at DESC)
  - (client_id, building_id, detected_at DESC)
  - (meter_reading_id, exception_type, status) WHERE (meter_reading_id IS NOT NULL)
  - (reconciliation_id, status) WHERE (reconciliation_id IS NOT NULL)
  - UNIQUE (replacement_meter_reading_id) WHERE (replacement_meter_reading_id IS NOT NULL)
  - (reviewer_user_id, status) WHERE (reviewer_user_id IS NOT NULL)
  - UNIQUE (id)

### `utility_reading_dues`

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, completed_by_user_id→users, created_by_user_id→users, generated_task_id→generated_tasks, meter_id→utility_meters, meter_reading_id→utility_meter_readings, schedule_definition_id→schedule_definitions
- Referenced by: utility_operational_exceptions
- Indexes (7):
  - (building_id, due_at, status)
  - (client_id, building_id, due_at)
  - (meter_id, period_end DESC)
  - UNIQUE (meter_id, period_start, period_end)
  - UNIQUE (generated_task_id)
  - UNIQUE (meter_reading_id)
  - UNIQUE (id)

### `utility_type_configurations`

- FKs: client_id→clients
- Referenced by: utility_type_uoms
- Indexes (3):
  - (client_id, status, utility_type)
  - UNIQUE (client_id, utility_type)
  - UNIQUE (id)

### `utility_type_uoms`

- FKs: uom_id→units_of_measure, utility_type_configuration_id→utility_type_configurations
- Referenced by: none
- Indexes (5):
  - (utility_type_configuration_id, status)
  - UNIQUE (utility_type_configuration_id, uom_id)
  - UNIQUE (utility_type_configuration_id) WHERE (is_default AND (status = 'ACTIVE'::text))
  - UNIQUE (id)
  - (uom_id, status)

### `vendor_assignments`

- FKs: assigned_by_user_id→users, building_id→buildings, vendor_id→vendors, work_order_id→work_orders
- Referenced by: vendor_works
- Indexes (6):
  - UNIQUE (vendor_id, work_order_id) WHERE (status = 'ACTIVE'::text)
  - (assigned_by_user_id, status)
  - (building_id, status)
  - UNIQUE (id)
  - (vendor_id, status)
  - (work_order_id, status)

### `vendor_bast_bindings`

- FKs: accepted_by_user_id→users, bast_document_id→bast_documents, building_id→buildings, client_id→clients, completion_report_id→vendor_completion_reports, prepared_by_user_id→users, service_report_id→vendor_service_reports, submitted_by_user_id→users, vendor_work_id→vendor_works, work_order_id→work_orders
- Referenced by: bast_reconciliation_quarantines
- Indexes (6):
  - (bast_document_id)
  - (building_id, acceptance_status)
  - UNIQUE (client_id, bast_number)
  - UNIQUE (id)
  - (work_order_id, acceptance_status)
  - UNIQUE (vendor_work_id)

### `vendor_building_relationships`

- FKs: building_id→buildings, vendor_id→vendors
- Referenced by: vendor_capabilities
- Indexes (4):
  - UNIQUE (vendor_id, building_id) WHERE (status = 'ACTIVE'::text)
  - (building_id)
  - UNIQUE (id)
  - (vendor_id)

### `vendor_capabilities`

- FKs: service_catalog_id→service_catalog, vendor_building_relationship_id→vendor_building_relationships, vendor_id→vendors
- Referenced by: none
- Indexes (6):
  - UNIQUE (id)
  - (vendor_building_relationship_id)
  - (service_catalog_id) WHERE (service_catalog_id IS NOT NULL)
  - (status)
  - UNIQUE (vendor_id, code)
  - (vendor_id)

### `vendor_categories`

- FKs: client_id→clients
- Referenced by: vendors
- Indexes (4):
  - UNIQUE (client_id, code)
  - (client_id)
  - UNIQUE (id)
  - (status)

### `vendor_checklist_bindings`

- FKs: building_id→buildings, checklist_execution_id→checklist_executions, checklist_template_id→checklist_templates, client_id→clients, created_by_user_id→users, vendor_work_id→vendor_works, work_order_id→work_orders
- Referenced by: none
- Indexes (6):
  - UNIQUE (vendor_work_id, checklist_template_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (checklist_execution_id)
  - (building_id, status)
  - UNIQUE (id)
  - (checklist_template_id, status)
  - (vendor_work_id, status)

### `vendor_completion_reports`

- FKs: building_id→buildings, client_id→clients, completed_by_user_id→users, created_by_user_id→users, vendor_work_id→vendor_works, work_order_id→work_orders
- Referenced by: bast_documents, bast_submission_attempts, vendor_bast_bindings, vendor_invoices, vendor_service_reports
- Indexes (4):
  - (building_id, completion_status)
  - UNIQUE (id)
  - (work_order_id, completion_status)
  - UNIQUE (vendor_work_id)

### `vendor_compliance_documents`

- FKs: vendor_id→vendors
- Referenced by: vendor_licenses_certifications
- Indexes (5):
  - UNIQUE (vendor_id, document_type, document_number) WHERE (status = 'ACTIVE'::text)
  - (expiry_date)
  - UNIQUE (id)
  - (status)
  - (vendor_id)

### `vendor_invoice_history`

- FKs: changed_by_user_id→users, vendor_invoice_id→vendor_invoices
- Referenced by: none
- Indexes (2):
  - (vendor_invoice_id, changed_at)
  - UNIQUE (id)

### `vendor_invoices`

- FKs: bast_document_id→bast_documents, building_id→work_contracts, building_id→buildings, building_id→work_contracts, building_id→work_contracts, building_id→work_contracts, building_id→work_contracts, building_id→purchase_orders, building_id→purchase_orders, building_id→purchase_orders, building_id→purchase_orders, cancelled_by_user_id→users, client_id→work_contracts, client_id→work_contracts, client_id→work_contracts, client_id→work_contracts, client_id→work_contracts, client_id→purchase_orders, client_id→purchase_orders, client_id→purchase_orders, client_id→purchase_orders, client_id→clients, completion_report_id→vendor_completion_reports, created_by_user_id→users, finalized_by_user_id→users, purchase_order_id→purchase_orders, purchase_order_id→work_contracts, purchase_order_id→work_contracts, purchase_order_id→work_contracts, purchase_order_id→work_contracts, purchase_order_id→purchase_orders, purchase_order_id→purchase_orders, purchase_order_id→purchase_orders, purchase_order_id→work_contracts, purchase_order_id→purchase_orders, service_report_id→vendor_service_reports, vendor_id→purchase_orders, vendor_id→vendors, vendor_id→work_contracts, vendor_id→work_contracts, vendor_id→work_contracts, vendor_id→work_contracts, vendor_id→work_contracts, vendor_id→purchase_orders, vendor_id→purchase_orders, vendor_id→purchase_orders, vendor_work_id→vendor_works, verified_by_user_id→users, work_contract_id→work_contracts, work_contract_id→work_contracts, work_contract_id→work_contracts, work_contract_id→work_contracts, work_contract_id→work_contracts, work_contract_id→work_contracts, work_order_id→work_orders
- Referenced by: operational_budget_source_bindings, vendor_invoice_history
- Indexes (10):
  - (building_id, status)
  - UNIQUE (client_id, invoice_number)
  - (payment_status) WHERE (payment_status = ANY (ARRAY['PARTIALLY_PAID'::text, 'PAID'::text]))
  - UNIQUE (id)
  - (purchase_order_id) WHERE (purchase_order_id IS NOT NULL)
  - (vendor_id, status)
  - (vendor_work_id) WHERE (vendor_work_id IS NOT NULL)
  - (verification_status) WHERE (verification_status = ANY (ARRAY['VERIFIED'::text, 'DISCREPANCY'::text]))
  - (work_contract_id) WHERE (work_contract_id IS NOT NULL)
  - (work_order_id) WHERE (work_order_id IS NOT NULL)

### `vendor_licenses_certifications`

- FKs: document_reference→vendor_compliance_documents, vendor_id→vendors
- Referenced by: none
- Indexes (6):
  - UNIQUE (vendor_id, record_type, number) WHERE (status = 'ACTIVE'::text)
  - (document_reference)
  - (expiry_date)
  - UNIQUE (id)
  - (status)
  - (vendor_id)

### `vendor_pics`

- FKs: vendor_id→vendors
- Referenced by: none
- Indexes (4):
  - UNIQUE (id)
  - UNIQUE (vendor_id) WHERE is_primary
  - (status)
  - (vendor_id)

### `vendor_quotation_lines`

- FKs: created_by_session_id→rfq_vendor_access_sessions, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, quotation_revision_id→vendor_quotation_revisions, required_uom_id→units_of_measure, rfq_id→rfq_lines, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→vendor_quotation_revisions, rfq_id→rfq_lines, rfq_line_id→rfq_lines, rfq_line_id→rfq_lines, source_service_id→service_catalog
- Referenced by: rfq_award_po_line_provenance, rfq_comparison_lines
- Indexes (5):
  - UNIQUE (id)
  - (quotation_revision_id, line_number_snapshot)
  - UNIQUE (quotation_revision_id, rfq_line_id)
  - (rfq_line_id)
  - (source_service_id) WHERE (source_service_id IS NOT NULL)

### `vendor_quotation_revisions`

- FKs: building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→vendor_quotations, building_id→vendor_quotations, building_id→rfq_vendor_access_sessions, building_id→vendor_quotations, building_id→rfq_vendor_access_sessions, building_id→vendor_quotations, building_id→vendor_quotations, building_id→vendor_quotations, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→vendor_quotations, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→vendor_quotations, client_id→vendor_quotations, client_id→vendor_quotations, client_id→vendor_quotations, client_id→vendor_quotations, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, invitation_id→vendor_quotations, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→vendor_quotations, invitation_id→rfq_vendor_access_sessions, invitation_id→vendor_quotations, invitation_id→vendor_quotations, invitation_id→vendor_quotations, invitation_id→vendor_quotations, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, quotation_id→vendor_quotations, quotation_id→vendor_quotations, quotation_id→vendor_quotations, quotation_id→vendor_quotations, quotation_id→vendor_quotations, quotation_id→vendor_quotations, quotation_id→vendor_quotations, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→vendor_quotations, rfq_id→vendor_quotations, rfq_id→vendor_quotations, rfq_id→vendor_quotations, rfq_id→vendor_quotations, rfq_id→vendor_quotations, rfq_id→rfq_vendor_access_sessions, submitted_by_session_id→rfq_vendor_access_sessions, submitted_by_session_id→rfq_vendor_access_sessions, submitted_by_session_id→rfq_vendor_access_sessions, submitted_by_session_id→rfq_vendor_access_sessions, submitted_by_session_id→rfq_vendor_access_sessions, submitted_by_session_id→rfq_vendor_access_sessions, submitted_by_session_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→vendor_quotations, vendor_id→vendor_quotations, vendor_id→vendor_quotations, vendor_id→vendor_quotations, vendor_id→vendor_quotations, vendor_id→vendor_quotations, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions
- Referenced by: rfq_award_po_conversions, rfq_award_po_line_provenance, rfq_awards, rfq_comparison_evaluations, rfq_comparison_evidence, rfq_recommendations, vendor_quotation_lines
- Indexes (7):
  - UNIQUE (quotation_id, idempotency_key)
  - UNIQUE (quotation_id, revision_number)
  - UNIQUE (quotation_id) WHERE (status = 'DRAFT'::text)
  - UNIQUE (id)
  - (quotation_id, revision_number DESC)
  - (rfq_id, status, created_at DESC)
  - UNIQUE (id, quotation_id, rfq_id)

### `vendor_quotations`

- FKs: building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_invitations, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, building_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_invitations, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_access_sessions, client_id→rfq_vendor_invitations, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, created_by_session_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_access_sessions, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, invitation_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_invitations, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_access_sessions, rfq_id→rfq_vendor_invitations, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_invitations, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions, vendor_id→rfq_vendor_access_sessions
- Referenced by: rfq_comparison_evidence, vendor_quotation_revisions
- Indexes (7):
  - (building_id, status, created_at DESC)
  - UNIQUE (invitation_id, idempotency_key)
  - UNIQUE (invitation_id)
  - UNIQUE (id)
  - (rfq_id, status, created_at DESC)
  - UNIQUE (id, invitation_id, rfq_id, vendor_id, client_id, building_id)
  - (vendor_id, status, created_at DESC)

### `vendor_rework_cycles`

- FKs: requested_by_user_id→users, resubmitted_by_user_id→users, review_id→reviews, vendor_work_id→vendor_works
- Referenced by: none
- Indexes (5):
  - UNIQUE (vendor_work_id) WHERE (status = 'REQUESTED'::text)
  - UNIQUE (id)
  - (requested_by_user_id, requested_at)
  - UNIQUE (review_id)
  - (vendor_work_id, requested_at)

### `vendor_selection_readiness`

- FKs: building_id→buildings, client_id→service_catalog, client_id→clients, client_id→service_catalog, evaluated_by_user_id→users, purchase_request_id→purchase_requests, service_catalog_id→service_catalog, service_catalog_id→service_catalog, service_request_id→service_requests, vendor_id→vendors
- Referenced by: none
- Indexes (5):
  - (building_id, request_type, evaluated_at)
  - UNIQUE (id)
  - (request_type, purchase_request_id, service_request_id)
  - (vendor_id, evaluated_at)
  - UNIQUE (vendor_id, purchase_request_id, service_request_id)

### `vendor_service_cost_history`

- FKs: changed_by_user_id→users, vendor_service_cost_id→vendor_service_costs
- Referenced by: none
- Indexes (2):
  - (vendor_service_cost_id, changed_at)
  - UNIQUE (id)

### `vendor_service_costs`

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, created_by_user_id→users, finalized_by_user_id→users, service_request_id→service_requests, vendor_id→vendors, vendor_work_id→vendor_works, work_order_id→work_orders
- Referenced by: basic_expenses, operational_budget_source_bindings, vendor_service_cost_history
- Indexes (5):
  - (building_id, cost_date DESC)
  - UNIQUE (id)
  - (status, cost_date DESC)
  - (vendor_id, cost_date DESC)
  - (work_order_id, cost_date DESC)

### `vendor_service_reports`

- FKs: building_id→buildings, client_id→clients, completion_report_id→vendor_completion_reports, prepared_by_user_id→users, vendor_work_id→vendor_works, work_order_id→work_orders
- Referenced by: bast_documents, bast_submission_attempts, vendor_bast_bindings, vendor_invoices
- Indexes (5):
  - (building_id, status)
  - UNIQUE (client_id, service_report_number)
  - UNIQUE (id)
  - (work_order_id, status)
  - UNIQUE (vendor_work_id)

### `vendor_workforce_bindings`

- FKs: vendor_id→vendors, workforce_profile_id→workforce_profiles
- Referenced by: permit_workers
- Indexes (5):
  - UNIQUE (vendor_id, workforce_profile_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (vendor_id, vendor_personnel_code)
  - UNIQUE (id)
  - (vendor_id)
  - (workforce_profile_id)

### `vendor_works`

- FKs: building_id→buildings, vendor_assignment_id→vendor_assignments, vendor_id→vendors, work_order_id→work_orders
- Referenced by: bast_documents, handover_documents, operational_events, vendor_bast_bindings, vendor_checklist_bindings, vendor_completion_reports, vendor_invoices, vendor_rework_cycles, vendor_service_costs, vendor_service_reports, work_completion_documents, work_permit_readiness
- Indexes (5):
  - UNIQUE (vendor_assignment_id)
  - (building_id, status)
  - UNIQUE (id)
  - (vendor_id, status)
  - (work_order_id, status)

### `vendors`

- FKs: client_id→clients, vendor_category_id→vendor_categories
- Referenced by: bast_documents, esg_waste_records, finding_assignments, handyman_provider_contexts, operational_commitments, permits, price_catalog_entries, purchase_order_readiness, purchase_orders, receivings, rfq_award_po_conversions, rfq_awards, rfq_comparison_evaluations, rfq_comparison_evidence, rfq_recommendations, rfq_vendor_invitations, service_requests, tenant_contractor_relationships, vendor_assignments, vendor_building_relationships, vendor_capabilities, vendor_compliance_documents, vendor_invoices, vendor_licenses_certifications, vendor_pics, vendor_selection_readiness, vendor_service_costs, vendor_workforce_bindings, vendor_works, work_contracts, work_order_assignments, work_order_procurement_bindings
- Indexes (6):
  - (client_id)
  - UNIQUE (client_id, vendor_code)
  - UNIQUE (id)
  - UNIQUE (id, client_id)
  - (status)
  - (vendor_category_id)

### `visit_check_ins`

- FKs: building_id→buildings, checked_in_by_user_id→users, checked_out_by_user_id→users, client_id→clients, expected_visitor_id→expected_visitors, visitor_id→visitors, walk_in_visit_id→walk_in_visits
- Referenced by: visitor_passes
- Indexes (7):
  - UNIQUE (expected_visitor_id) WHERE ((expected_visitor_id IS NOT NULL) AND (status = 'CHECKED_IN'::text))
  - UNIQUE (walk_in_visit_id) WHERE ((walk_in_visit_id IS NOT NULL) AND (status = 'CHECKED_IN'::text))
  - (building_id, status, checked_in_at)
  - (building_id, status, checked_out_at)
  - (client_id, status)
  - UNIQUE (id)
  - (visitor_id, status)

### `visitor_invitations`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, host_user_id→users, host_workforce_id→workforce_profiles, visitor_id→visitors
- Referenced by: expected_visitors
- Indexes (6):
  - (building_id, status, expected_arrival_at)
  - (client_id, status)
  - (host_user_id)
  - (host_workforce_id)
  - UNIQUE (id)
  - (visitor_id, status)

### `visitor_passes`

- FKs: building_id→buildings, cancelled_by_user_id→users, client_id→clients, issued_by_user_id→users, returned_by_user_id→users, visit_check_in_id→visit_check_ins
- Referenced by: none
- Indexes (6):
  - UNIQUE (visit_check_in_id) WHERE (status = 'ACTIVE'::text)
  - (building_id, status, issued_at)
  - (client_id, status)
  - UNIQUE (pass_code)
  - UNIQUE (id)
  - (visit_check_in_id, issued_at)

### `visitor_photos`

- FKs: client_id→clients, created_by_user_id→users, reviewed_by_user_id→users, visitor_id→visitors
- Referenced by: none
- Indexes (4):
  - (client_id, status)
  - (ocr_status, review_status)
  - UNIQUE (id)
  - (visitor_id, status)

### `visitors`

- FKs: client_id→clients, created_by_user_id→users
- Referenced by: contractor_visitors, delivery_couriers, expected_visitors, visit_check_ins, visitor_invitations, visitor_photos, walk_in_visits
- Indexes (6):
  - (client_id, status)
  - UNIQUE (client_id, identity_type, identity_number) WHERE (identity_number IS NOT NULL)
  - (client_id, lower(email))
  - (client_id, lower(full_name))
  - (client_id, phone)
  - UNIQUE (id)

### `walk_in_visits`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, host_user_id→users, host_workforce_id→workforce_profiles, visitor_id→visitors
- Referenced by: contractor_visitors, delivery_couriers, host_confirmations, visit_check_ins
- Indexes (7):
  - UNIQUE (building_id, visitor_id) WHERE (status = 'REGISTERED'::text)
  - (building_id, status, arrived_at)
  - (client_id, status)
  - (host_user_id)
  - (host_workforce_id)
  - UNIQUE (id)
  - (visitor_id, status)

### `work_completion_documents`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, document_id→documents, vendor_work_id→vendor_works, work_order_id→work_orders
- Referenced by: bast_documents, bast_submission_attempts, handover_documents
- Indexes (8):
  - (building_id, context_type)
  - (client_id)
  - (context_type)
  - UNIQUE (document_id)
  - (document_id)
  - UNIQUE (id)
  - (vendor_work_id)
  - (work_order_id)

### `work_contract_history`

- FKs: changed_by_user_id→users, work_contract_id→work_contracts
- Referenced by: none
- Indexes (2):
  - (work_contract_id, changed_at)
  - UNIQUE (id)

### `work_contracts`

- FKs: activated_by_user_id→users, building_id→purchase_orders, building_id→purchase_orders, building_id→purchase_orders, building_id→buildings, building_id→purchase_orders, cancelled_by_user_id→users, client_id→purchase_orders, client_id→clients, client_id→purchase_orders, client_id→purchase_orders, client_id→purchase_orders, completed_by_user_id→users, created_by_user_id→users, purchase_order_id→purchase_orders, purchase_order_id→purchase_orders, purchase_order_id→purchase_orders, purchase_order_id→purchase_orders, purchase_order_id→purchase_orders, vendor_id→purchase_orders, vendor_id→vendors, vendor_id→purchase_orders, vendor_id→purchase_orders, vendor_id→purchase_orders
- Referenced by: vendor_invoices, work_contract_history, work_order_procurement_bindings
- Indexes (8):
  - (building_id, status, spk_date DESC)
  - UNIQUE (id, client_id, building_id, vendor_id, purchase_order_id)
  - (client_id, status, spk_date DESC)
  - UNIQUE (client_id, spk_number)
  - UNIQUE (id)
  - UNIQUE (purchase_order_id) WHERE (status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text]))
  - (purchase_order_id)
  - (vendor_id, status, spk_date DESC)

### `work_order_actions`

Append-only Work Order action trail (actor, type, occurred_at).

- FKs: actor_user_id→users, work_order_id→work_orders
- Referenced by: none
- Indexes (4):
  - (actor_user_id, occurred_at)
  - UNIQUE (id)
  - (action_type, occurred_at)
  - (work_order_id, occurred_at)

### `work_order_assignments`

Work Order assignment history (team/vendor/workforce), one ACTIVE per Work Order (partial unique).

- FKs: assigned_by_user_id→users, team_id→teams, vendor_id→vendors, work_order_id→work_orders, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (7):
  - UNIQUE (work_order_id) WHERE (status = 'ACTIVE'::text)
  - (assigned_by_user_id, status)
  - UNIQUE (id)
  - (team_id, status)
  - (vendor_id, status)
  - (work_order_id, status)
  - (workforce_profile_id, status)

### `work_order_procurement_bindings`

- FKs: building_id→work_contracts, building_id→work_contracts, building_id→work_contracts, building_id→work_contracts, building_id→work_contracts, building_id→buildings, client_id→work_contracts, client_id→work_contracts, client_id→work_contracts, client_id→clients, client_id→work_contracts, client_id→work_contracts, created_by_user_id→users, material_request_id→material_requests, purchase_order_id→work_contracts, purchase_order_id→work_contracts, purchase_order_id→purchase_orders, purchase_order_id→work_contracts, purchase_order_id→work_contracts, purchase_order_id→work_contracts, purchase_request_id→purchase_requests, receiving_id→receivings, service_request_id→service_requests, vendor_id→work_contracts, vendor_id→work_contracts, vendor_id→work_contracts, vendor_id→work_contracts, vendor_id→work_contracts, vendor_id→vendors, work_contract_id→work_contracts, work_contract_id→work_contracts, work_contract_id→work_contracts, work_contract_id→work_contracts, work_contract_id→work_contracts, work_contract_id→work_contracts, work_order_id→work_orders
- Referenced by: none
- Indexes (10):
  - (building_id, procurement_status)
  - (material_request_id)
  - (purchase_order_id) WHERE (purchase_order_id IS NOT NULL)
  - (purchase_request_id, procurement_status)
  - (service_request_id)
  - (vendor_id) WHERE (vendor_id IS NOT NULL)
  - (work_contract_id) WHERE (work_contract_id IS NOT NULL)
  - (work_order_id, procurement_status)
  - UNIQUE (work_order_id)
  - UNIQUE (id)

### `work_orders`

Authoritative property Work Order lifecycle (BE-08) — OPEN→…→CLOSED with assignments, actions, SLA.

- FKs: asset_id→assets, building_id→buildings, client_id→clients, completed_by_user_id→users, created_by_user_id→users, functional_location_id→functional_locations, work_request_id→work_requests
- Referenced by: applied_slas, bast_documents, breakdown_bindings, handover_documents, inventory_work_order_material_usages, maintenance_bindings, operational_commitments, purchase_requests, sla_escalation_actions, tenant_complaints, tenant_service_requests, tenant_utility_requests, vendor_assignments, vendor_bast_bindings, vendor_checklist_bindings, vendor_completion_reports, vendor_invoices, vendor_service_costs, vendor_service_reports, vendor_works, work_completion_documents, work_order_actions, work_order_assignments, work_order_procurement_bindings, work_permit_readiness
- Indexes (13):
  - UNIQUE (work_request_id)
  - UNIQUE (client_id, work_order_number)
  - (asset_id)
  - (bast_requirement, status)
  - (building_id, status, created_at)
  - (client_id, status, created_at)
  - (completed_by_user_id, status)
  - (created_by_user_id, status)
  - (functional_location_id)
  - UNIQUE (id)
  - (priority, status)
  - (work_request_id)
  - (work_type, status)

### `work_permit_readiness`

- FKs: building_id→buildings, client_id→clients, created_by_user_id→users, vendor_work_id→vendor_works, work_order_id→work_orders
- Referenced by: none
- Indexes (5):
  - (building_id, readiness_status)
  - UNIQUE (id)
  - UNIQUE (vendor_work_id, permit_requirement_type)
  - (vendor_work_id)
  - (work_order_id, readiness_status)

### `work_requests`

- FKs: building_id→buildings, client_id→clients, requested_by_user_id→users
- Referenced by: housekeeping_complaint_bindings, tenant_service_requests, tenant_utility_requests, work_orders
- Indexes (6):
  - UNIQUE (client_id, request_number)
  - (building_id, status, requested_at)
  - (client_id, status, requested_at)
  - UNIQUE (id)
  - (request_type, status)
  - (requested_by_user_id, status)

### `workforce_building_assignments`

- FKs: building_id→buildings, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (5):
  - UNIQUE (workforce_profile_id, building_id) WHERE (status = 'ACTIVE'::text)
  - (building_id)
  - UNIQUE (id)
  - (status)
  - (workforce_profile_id)

### `workforce_profiles`

- FKs: department_id→departments, organization_id→organizations, position_id→positions, team_id→teams, user_id→users
- Referenced by: attendance_records, checklist_executions, contractor_visitors, corrective_action_responsibilities, delivery_couriers, expected_visitors, external_workforce_links, finding_assignments, form_instances, handyman_worker_contexts, host_confirmations, security_incident_readiness, security_key_custody, security_logbook_entries, security_visitor_bindings, task_assignments, vendor_workforce_bindings, visitor_invitations, walk_in_visits, work_order_assignments, workforce_building_assignments, workforce_reporting_lines, workforce_shift_assignments, workforce_skill_assignments
- Indexes (7):
  - (department_id)
  - UNIQUE (organization_id, employee_code)
  - (organization_id)
  - UNIQUE (id)
  - (position_id)
  - (team_id)
  - UNIQUE (user_id)

### `workforce_reporting_lines`

- FKs: supervisor_workforce_profile_id→workforce_profiles, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (5):
  - UNIQUE (workforce_profile_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (status)
  - (supervisor_workforce_profile_id)
  - (workforce_profile_id)

### `workforce_shift_assignments`

- FKs: security_post_id→security_posts, shift_id→shifts, workforce_profile_id→workforce_profiles
- Referenced by: attendance_records, operational_incidents
- Indexes (6):
  - UNIQUE (workforce_profile_id, shift_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (security_post_id)
  - (shift_id)
  - (status)
  - (workforce_profile_id)

### `workforce_skill_assignments`

- FKs: skill_id→skills, workforce_profile_id→workforce_profiles
- Referenced by: none
- Indexes (5):
  - UNIQUE (workforce_profile_id, skill_id) WHERE (status = 'ACTIVE'::text)
  - UNIQUE (id)
  - (skill_id)
  - (status)
  - (workforce_profile_id)

### `workspaces`

- FKs: building_id→buildings, client_id→clients, module_id→modules, permission_id→permissions
- Referenced by: none
- Indexes (5):
  - UNIQUE (building_id, workspace_key) WHERE (scope_type = 'BUILDING'::text)
  - UNIQUE (client_id, workspace_key) WHERE (scope_type = 'CLIENT'::text)
  - (module_id, feature_key)
  - (permission_id)
  - UNIQUE (id)

