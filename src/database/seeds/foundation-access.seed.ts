import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Seed } from './types';

/**
 * BE-01F bootstrap access data.
 *
 * Provides the explicit, idempotent identity/access foundation:
 *   35 permission codes, the PLATFORM_ADMIN role, and their assignments.
 *
 * This is the ONLY bootstrap data for RBAC. No user, credential, or password
 * is seeded here — provisioning an administrator is an explicit account
 * lifecycle operation (BE-01G), never a hidden bypass.
 */
export const FOUNDATION_PERMISSIONS: readonly {
  code: string;
  name: string;
}[] = [
  { code: 'user.read', name: 'Read Users' },
  { code: 'user.manage', name: 'Manage Users' },
  { code: 'role.read', name: 'Read Roles' },
  { code: 'role.manage', name: 'Manage Roles' },
  { code: 'permission.read', name: 'Read Permissions' },
  { code: 'permission.manage', name: 'Manage Permissions' },
  { code: 'auth.audit.read', name: 'Read Authentication Audit' },
  { code: 'client.read', name: 'Read Clients' },
  { code: 'client.manage', name: 'Manage Clients' },
  { code: 'subscription.read', name: 'Read Subscriptions' },
  { code: 'subscription.manage', name: 'Manage Subscriptions' },
  { code: 'license.read', name: 'Read Licenses' },
  { code: 'license.manage', name: 'Manage Licenses' },
  { code: 'module.read', name: 'Read Modules' },
  { code: 'module.manage', name: 'Manage Modules' },
  { code: 'entitlement.read', name: 'Read Entitlements' },
  { code: 'entitlement.manage', name: 'Manage Entitlements' },
  { code: 'property.read', name: 'Read Properties' },
  { code: 'property.manage', name: 'Manage Properties' },
  { code: 'building.read', name: 'Read Buildings' },
  { code: 'building.manage', name: 'Manage Buildings' },
  // BE-04A — Floor
  { code: 'floor.read', name: 'Read Floors' },
  { code: 'floor.manage', name: 'Manage Floors' },
  // BE-04B — Campus
  { code: 'campus.read', name: 'Read Campuses' },
  { code: 'campus.manage', name: 'Manage Campuses' },
  // BE-04C — Area / Zone
  { code: 'area.read', name: 'Read Areas' },
  { code: 'area.manage', name: 'Manage Areas' },
  // BE-04D — Room
  { code: 'room.read', name: 'Read Rooms' },
  { code: 'room.manage', name: 'Manage Rooms' },
  // BE-04E — Room Type
  { code: 'room_type.read', name: 'Read Room Types' },
  { code: 'room_type.manage', name: 'Manage Room Types' },
  // BE-04F — Space
  { code: 'space.read', name: 'Read Spaces' },
  { code: 'space.manage', name: 'Manage Spaces' },
  // BE-04G — Functional Location
  { code: 'functional_location.read', name: 'Read Functional Locations' },
  { code: 'functional_location.manage', name: 'Manage Functional Locations' },
  // BE-05A — Asset Registry
  { code: 'asset.read', name: 'Read Assets' },
  { code: 'asset.manage', name: 'Manage Assets' },
  // BE-05B — Asset Classification
  { code: 'asset_category.read', name: 'Read Asset Categories' },
  { code: 'asset_category.manage', name: 'Manage Asset Categories' },
  { code: 'asset_type.read', name: 'Read Asset Types' },
  { code: 'asset_type.manage', name: 'Manage Asset Types' },
  // BE-05D — Equipment Profile
  { code: 'equipment_profile.read', name: 'Read Equipment Profiles' },
  { code: 'equipment_profile.manage', name: 'Manage Equipment Profiles' },
  // BE-05F — Asset Warranty
  { code: 'asset_warranty.read', name: 'Read Asset Warranties' },
  { code: 'asset_warranty.manage', name: 'Manage Asset Warranties' },
  // BE-05G — Asset Certification
  { code: 'asset_certification.read', name: 'Read Asset Certifications' },
  { code: 'asset_certification.manage', name: 'Manage Asset Certifications' },
  // BE-05H — Asset Identifier / QR
  { code: 'asset_identifier.read', name: 'Read Asset Identifiers' },
  { code: 'asset_identifier.manage', name: 'Manage Asset Identifiers' },
  // BE-05I — Asset History
  { code: 'asset_history.read', name: 'Read Asset History' },
  // BE-07B — Form Template
  { code: 'form_template.read', name: 'Read Form Templates' },
  { code: 'form_template.manage', name: 'Manage Form Templates' },
  // MOB-C07 PART 01C — operational Form Instance execution. Dedicated code;
  // not sufficient by itself (future mobile mutation still requires exact
  // bound generated task + Client/Building + assignment + current shift +
  // non-terminal task + lifecycle). Granted to PLATFORM_ADMIN by the
  // existing all-catalogue-except-exclusions seed. Must not be attached to
  // generic form-instance routes (those stay on form_template.manage).
  { code: 'form_instance.execute', name: 'Execute Form Instances' },
  // BE-07A — Source Form Register
  { code: 'source_form.read', name: 'Read Source Forms' },
  { code: 'source_form.manage', name: 'Manage Source Forms' },
  // BE-06A — Vendor Registry
  { code: 'vendor.read', name: 'Read Vendors' },
  { code: 'vendor.manage', name: 'Manage Vendors' },
  // BE-08A — Work Request
  { code: 'work_request.read', name: 'Read Work Requests' },
  { code: 'work_request.manage', name: 'Manage Work Requests' },
  // BE-08B — Work Order
  { code: 'work_order.read', name: 'Read Work Orders' },
  { code: 'work_order.manage', name: 'Manage Work Orders' },
  // BE-09A — Finding Foundation
  { code: 'finding.read', name: 'Read Findings' },
  { code: 'finding.manage', name: 'Manage Findings' },
  // BE-09J — Finding workflow authority
  { code: 'finding.assign', name: 'Assign Findings' },
  { code: 'finding.execute', name: 'Execute Findings' },
  { code: 'finding.review', name: 'Review Findings' },
  { code: 'finding.close', name: 'Close Findings' },
  // BE-10A — Daily Engineering Operations
  { code: 'engineering.read', name: 'Read Engineering Daily Operations' },
  // BE-10B — Equipment Inspection Binding
  { code: 'inspection_binding.read', name: 'Read Inspection Bindings' },
  { code: 'inspection_binding.manage', name: 'Manage Inspection Bindings' },
  // BE-10C — Meter Reading Binding
  { code: 'meter_reading_binding.read', name: 'Read Meter Reading Bindings' },
  { code: 'meter_reading_binding.manage', name: 'Manage Meter Reading Bindings' },
  // BE-10D — Equipment Log Sheet Binding
  { code: 'log_sheet_binding.read', name: 'Read Log Sheet Bindings' },
  { code: 'log_sheet_binding.manage', name: 'Manage Log Sheet Bindings' },
  // BE-10E — Engineering Checklist Binding
  { code: 'engineering_checklist_binding.read', name: 'Read Engineering Checklist Bindings' },
  { code: 'engineering_checklist_binding.manage', name: 'Manage Engineering Checklist Bindings' },
  // BE-10F — Breakdown / Corrective Binding
  { code: 'breakdown.read', name: 'Read Breakdowns' },
  { code: 'breakdown.manage', name: 'Manage Breakdowns' },
  // BE-10G — Maintenance Operational Binding
  { code: 'maintenance_binding.read', name: 'Read Maintenance Bindings' },
  { code: 'maintenance_binding.manage', name: 'Manage Maintenance Bindings' },
  // BE-10H — Engineering Finding Binding
  { code: 'engineering_finding.read', name: 'Read Engineering Findings' },
  { code: 'engineering_finding.manage', name: 'Manage Engineering Findings' },
  // BE-10I — Technical Report Dataset
  { code: 'engineering_report.read', name: 'Read Engineering Reports' },
  // BE-10J — Shift Handover
  { code: 'shift_handover.read', name: 'Read Shift Handovers' },
  { code: 'shift_handover.manage', name: 'Manage Shift Handovers' },
  // BE-10K — Engineering Aggregation API
  { code: 'engineering_overview.read', name: 'Read Engineering Overview' },
  // BE-11A — Cleaning Area
  { code: 'cleaning_area.read', name: 'Read Cleaning Areas' },
  { code: 'cleaning_area.manage', name: 'Manage Cleaning Areas' },
  // BE-11B — Cleaning Schedule Binding
  { code: 'cleaning_schedule.read', name: 'Read Cleaning Schedules' },
  { code: 'cleaning_schedule.manage', name: 'Manage Cleaning Schedules' },
  // BE-11C — Daily Cleaning
  { code: 'daily_cleaning.read', name: 'Read Daily Cleaning' },
  { code: 'daily_cleaning.manage', name: 'Manage Daily Cleaning' },
  // BE-11D — Cleaning Assignment
  { code: 'cleaning_assignment.read', name: 'Read Cleaning Assignments' },
  { code: 'cleaning_assignment.manage', name: 'Manage Cleaning Assignments' },
  // BE-11E — Toilet Inspection
  { code: 'toilet_inspection.read', name: 'Read Toilet Inspections' },
  { code: 'toilet_inspection.manage', name: 'Manage Toilet Inspections' },
  // BE-11F — Public Area Inspection
  { code: 'public_area_inspection.read', name: 'Read Public Area Inspections' },
  { code: 'public_area_inspection.manage', name: 'Manage Public Area Inspections' },
  // BE-11G — Supervisor Inspection
  { code: 'supervisor_inspection.read', name: 'Read Supervisor Inspections' },
  { code: 'supervisor_inspection.manage', name: 'Manage Supervisor Inspections' },
  // BE-11H — Finding / Re-clean / Rework Binding
  { code: 'housekeeping_finding.read', name: 'Read Housekeeping Findings' },
  { code: 'housekeeping_finding.manage', name: 'Manage Housekeeping Findings' },
  // BE-11I — Evidence Binding
  { code: 'housekeeping_evidence.read', name: 'Read Housekeeping Evidence' },
  { code: 'housekeeping_evidence.manage', name: 'Manage Housekeeping Evidence' },
  // BE-11J — Consumable Readiness
  { code: 'consumable_readiness.read', name: 'Read Consumable Readiness' },
  { code: 'consumable_readiness.manage', name: 'Manage Consumable Readiness' },
  // BE-11K — Quality Audit
  { code: 'quality_audit.read', name: 'Read Quality Audits' },
  { code: 'quality_audit.manage', name: 'Manage Quality Audits' },
  // BE-11L — Complaint Binding
  { code: 'housekeeping_complaint.read', name: 'Read Housekeeping Complaints' },
  { code: 'housekeeping_complaint.manage', name: 'Manage Housekeeping Complaints' },
  // BE-11M — Housekeeping Report Dataset
  { code: 'housekeeping_report.read', name: 'Read Housekeeping Reports' },
  // BE-12A — Security Post
  { code: 'security_post.read', name: 'Read Security Posts' },
  { code: 'security_post.manage', name: 'Manage Security Posts' },
  // BE-12B — Patrol Route
  { code: 'patrol_route.read', name: 'Read Patrol Routes' },
  { code: 'patrol_route.manage', name: 'Manage Patrol Routes' },
  // BE-12C — Patrol Schedule Binding
  { code: 'patrol_schedule.read', name: 'Read Patrol Schedule Bindings' },
  { code: 'patrol_schedule.manage', name: 'Manage Patrol Schedule Bindings' },
  // BE-12D — Patrol Execution
  { code: 'patrol_execution.read', name: 'Read Patrol Executions' },
  { code: 'patrol_execution.manage', name: 'Manage Patrol Executions' },
  // BE-12E — Patrol Checklist Binding
  { code: 'patrol_checklist_binding.read', name: 'Read Patrol Checklist Bindings' },
  { code: 'patrol_checklist_binding.manage', name: 'Manage Patrol Checklist Bindings' },
  // BE-12F — Security Daily Activity
  { code: 'security_daily_activity.read', name: 'Read Security Daily Activity' },
  // BE-12G — Security Shift Handover Binding
  { code: 'security_shift_handover.read', name: 'Read Security Shift Handovers' },
  { code: 'security_shift_handover.manage', name: 'Manage Security Shift Handovers' },
  // BE-12H — Security Finding Binding
  { code: 'security_finding.read', name: 'Read Security Findings' },
  { code: 'security_finding.manage', name: 'Manage Security Findings' },
  // BE-12I — Security Incident Readiness
  { code: 'security_incident_readiness.read', name: 'Read Security Incident Readiness' },
  { code: 'security_incident_readiness.manage', name: 'Manage Security Incident Readiness' },
  // BE-12J — Visitor / Security Binding
  { code: 'security_visitor_binding.read', name: 'Read Security Visitor Bindings' },
  { code: 'security_visitor_binding.manage', name: 'Manage Security Visitor Bindings' },
  // BE-12K — Security Key Control
  { code: 'security_key.read', name: 'Read Security Keys' },
  { code: 'security_key.manage', name: 'Manage Security Keys' },
  // BE-12L — Security Lost & Found
  { code: 'security_lost_found.read', name: 'Read Security Lost & Found' },
  {
    code: 'security_lost_found.manage',
    name: 'Manage Security Lost & Found',
  },
  // BE-12M — Security Reporting Dataset
  { code: 'security_report.read', name: 'Read Security Reports' },
  // BE-13A — Visitor Identity / Registration
  { code: 'visitor.read', name: 'Read Visitors' },
  { code: 'visitor.manage', name: 'Manage Visitors' },
  // BE-13B — Visitor Invitation
  { code: 'visitor_invitation.read', name: 'Read Visitor Invitations' },
  { code: 'visitor_invitation.manage', name: 'Manage Visitor Invitations' },
  // BE-13C — Expected Visitor
  { code: 'expected_visitor.read', name: 'Read Expected Visitors' },
  { code: 'expected_visitor.manage', name: 'Manage Expected Visitors' },
  // BE-13D — Walk-In / Guest Book
  { code: 'walk_in_visit.read', name: 'Read Walk-In Visits' },
  { code: 'walk_in_visit.manage', name: 'Manage Walk-In Visits' },
  // BE-13E — Visitor Photo / OCR Readiness
  { code: 'visitor_photo.read', name: 'Read Visitor Photos' },
  { code: 'visitor_photo.manage', name: 'Manage Visitor Photos' },
  // BE-13F — Host / Tenant Confirmation
  { code: 'host_confirmation.read', name: 'Read Host Confirmations' },
  { code: 'host_confirmation.manage', name: 'Manage Host Confirmations' },
  // BE-13G / BE-13H — Check-In / Check-Out
  { code: 'visit_check_in.read', name: 'Read Visit Check-Ins' },
  { code: 'visit_check_in.manage', name: 'Manage Visit Check-Ins' },
  // BE-13I — Visitor Pass
  { code: 'visitor_pass.read', name: 'Read Visitor Passes' },
  { code: 'visitor_pass.manage', name: 'Manage Visitor Passes' },
  // BE-13J — Contractor Visitor
  { code: 'contractor_visitor.read', name: 'Read Contractor Visitors' },
  { code: 'contractor_visitor.manage', name: 'Manage Contractor Visitors' },
  // BE-13K — Delivery / Courier
  { code: 'delivery_courier.read', name: 'Read Delivery / Courier Records' },
  { code: 'delivery_courier.manage', name: 'Manage Delivery / Courier Records' },
  // BE-13L — Front Desk Log
  { code: 'front_desk_log.read', name: 'Read Front Desk Log' },
  // BE-14A — Tenant Company
  { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
  // BE-16A — Inventory Item Master
  { code: 'inventory_item.read', name: 'Read Inventory Items' },
  { code: 'inventory_item.manage', name: 'Manage Inventory Items' },
  // BE-16B — Warehouse / Store
  { code: 'inventory_warehouse.read', name: 'Read Warehouses/Stores' },
  { code: 'inventory_warehouse.manage', name: 'Manage Warehouses/Stores' },
  // BE-16C — Stock Balance
  { code: 'inventory_stock.read', name: 'Read Stock Balances' },
  { code: 'inventory_stock.manage', name: 'Manage Stock Balances' },
  // BE-17A — Purchase Request
  { code: 'purchase_request.read', name: 'Read Purchase Requests' },
  { code: 'purchase_request.manage', name: 'Manage Purchase Requests' },
  // BE-17B — Material Request
  { code: 'material_request.read', name: 'Read Material Requests' },
  { code: 'material_request.manage', name: 'Manage Material Requests' },
  // CR-BE-RN11-MATERIAL-FIELD-01 PART 01 — field (technician) material
  // request authority on a Work Order. Deliberately separate from
  // `material_request.manage` / `purchase_request.manage`: raising demand for
  // the Work Order one is executing is FIELD authority, not procurement
  // administration, and the two must be grantable / revocable independently.
  // Granted to PLATFORM_ADMIN by default (ordinary operational capability).
  { code: 'material_request.field.read', name: 'Read Field Material Requests' },
  { code: 'material_request.field.request', name: 'Request Field Materials' },
  // CR-BE-RN11-MATERIAL-FIELD-01 PART 03 — record canonical Work Order material
  // usage (STOCK_OUT issue) from the field. Not inventory_stock.manage.
  { code: 'material_usage.field.record', name: 'Record Field Material Usage' },
  // BE-17C — Service Request
  { code: 'service_request.read', name: 'Read Service Requests' },
  { code: 'service_request.manage', name: 'Manage Service Requests' },
  // CR-BE-PRO-02 PART 01 — RFQ foundation and typed demand lineage
  { code: 'rfq.read', name: 'Read RFQs' },
  { code: 'rfq.manage', name: 'Manage RFQs' },
  // CR-BE-PRO-02 PART 05 — sensitive award command, deliberately unassigned
  { code: 'rfq.award', name: 'Finalize RFQ Awards' },
  // CR-BE-PRICE-01 PART 01 — Price Catalog / Price Authority. Managing a
  // governed reference price is distinct from committing spend
  // (`purchase_order.*`) and from awarding an RFQ (`rfq.award`).
  { code: 'price_catalog.read', name: 'Read Price Catalog Entries' },
  { code: 'price_catalog.manage', name: 'Manage Price Catalog Entries' },
  // CR-BE-PRICE-01 — sensitive retroactive-correction authority. Deliberately
  // separate from `price_catalog.manage`: stewarding prices must not imply
  // the authority to rewrite an already-effective window. Granted to no role
  // by default (see UNASSIGNED_BY_DEFAULT_PERMISSION_CODES).
  { code: 'price_catalog.override', name: 'Override Price Catalog Windows' },
  // CR-BE-SVC-01 PART 01 — Service Catalog Foundation (governed Service master
  // identity). A reference master, so only read/manage (no exceptional
  // `.override` — that risk class belongs to the price window). Granted to
  // PLATFORM_ADMIN by default (governance §12).
  { code: 'service_catalog.read', name: 'Read Service Catalog Entries' },
  { code: 'service_catalog.manage', name: 'Manage Service Catalog Entries' },
  // CR-BE-ESG-01 PART 01 — ESG Metric Definition Foundation (governed ESG
  // metric vocabulary). Reference master for ENERGY/WATER/WASTE/EMISSIONS/OTHER.
  // Read/manage for definition lifecycle, verify for data-quality verification
  // (segregated authority). Granted to PLATFORM_ADMIN by default.
  { code: 'esg.read', name: 'Read ESG Metric Definitions' },
  { code: 'esg.manage', name: 'Manage ESG Metric Definitions' },
  { code: 'esg.verify', name: 'Verify ESG Metric Data' },
  // BE-17D — Procurement Approval Binding
  { code: 'procurement_approval.read', name: 'Read Procurement Approvals' },
  { code: 'procurement_approval.manage', name: 'Manage Procurement Approvals' },
  // BE-17E — Vendor Selection Readiness
  { code: 'vendor_selection.read', name: 'Read Vendor Selection Readiness' },
  { code: 'vendor_selection.manage', name: 'Manage Vendor Selection Readiness' },
  // BE-17F — Purchase Order Readiness
  { code: 'po_readiness.read', name: 'Read Purchase Order Readiness' },
  { code: 'po_readiness.manage', name: 'Manage Purchase Order Readiness' },
  // CR-BE-R2P-01 PART 01 — Purchase Order (commitment). Separate from
  // `po_readiness.*` on purpose: declaring that a request MAY be committed is
  // not authority to COMMIT the client to a vendor.
  { code: 'purchase_order.read', name: 'Read Purchase Orders' },
  { code: 'purchase_order.manage', name: 'Manage Purchase Orders' },
  // CR-BE-COM-02 — Vendor Invoice (payable authority). Its routes have
  // always required these codes; they were never seeded, so no role could be
  // granted them. Registered here as part of CR-BE-R2P-01 PART 06, which
  // extends this same domain.
  { code: 'vendor_invoice.read', name: 'Read Vendor Invoices' },
  { code: 'vendor_invoice.manage', name: 'Manage Vendor Invoices' },
  // CR-BE-R2P-01 PART 04 — SPK / Work Contract (execution mandate). Separate
  // from `purchase_order.*`: committing spend to a vendor is not the same
  // authority as ordering that vendor to start work.
  { code: 'work_contract.read', name: 'Read Work Contracts (SPK)' },
  { code: 'work_contract.manage', name: 'Manage Work Contracts (SPK)' },
  // BE-17G — Receiving
  { code: 'receiving.read', name: 'Read Receiving Records' },
  { code: 'receiving.manage', name: 'Manage Receiving Records' },
  // BE-17H — Work Order Procurement Binding
  { code: 'wo_procurement.read', name: 'Read Work Order Procurement Bindings' },
  { code: 'wo_procurement.manage', name: 'Manage Work Order Procurement Bindings' },
  // BE-18A — Utility Meter Master
  { code: 'utility_meter.read', name: 'Read Utility Meters' },
  { code: 'utility_meter.manage', name: 'Manage Utility Meters' },
  // CR-BE-RN12-METER-FIELD-01 PART 00 — read the mobile field meter context of a
  // Reading Due the caller is actually assigned to. Deliberately NOT
  // `utility_meter.read` / `utility_meter.manage`: those are meter
  // ADMINISTRATION, whereas identifying a meter at the point of capture is FIELD
  // authority, and the two must be grantable / revocable independently — the same
  // split CR-BE-RN11-MATERIAL-FIELD-01 drew between `material_request.field.read`
  // and `material_request.manage`. This grants NO write: reading submission stays
  // PART 01. Granted to PLATFORM_ADMIN by default (ordinary operational
  // capability), not an exceptional authority.
  { code: 'utility_meter.field.read', name: 'Read Field Utility Meter Context' },
  // CR-BE-RN12-METER-FIELD-01 PART 01 — submit a field Meter Reading against a
  // Reading Due the caller is assigned to. This is the WRITE half of the PART 00
  // split, and it is a separate code for the same reason: an actor may be allowed
  // to identify a meter at the point of capture without being allowed to post a
  // measurement against it. Deliberately NOT `utility_meter.manage` (meter master
  // administration), NOT `utility_meter.read` (dashboard visibility) and NOT
  // `meter_reading_binding.manage` (BE-10C engineering binding administration) —
  // none of those is standing in front of a meter recording a value, and the
  // field permission is never substituted by any of them. Naming follows the
  // `<domain>.field.<verb>` convention CR-BE-RN11-MATERIAL-FIELD-01 established
  // with `material_usage.field.record`. No role name is implied or checked.
  { code: 'utility_meter.field.record', name: 'Record Field Utility Meter Reading' },
  // CR-BE-RN12-METER-FIELD-01 PART 02 — attach, read and remove the READING
  // EVIDENCE of a field Meter Reading the caller is assigned to, read that
  // reading's canonical evidence readiness, see its OCR suggestions, and record
  // a human decision (confirm / reject) on one of those suggestions. This is a
  // third, separate code for the same reason PART 00 and PART 01 are separate:
  // identifying a meter (`field.read`), posting a measurement (`field.record`)
  // and proving / verifying that measurement (`field.evidence`) are grantable
  // and revocable independently — an organisation may let a technician post a
  // value without letting them decide an OCR suggestion, or the reverse.
  //
  // Deliberately NOT any of: `utility_meter.manage` (meter administration, and
  // the authority behind the BE-18F management evidence routes and the BE-18
  // OCR accept/reject routes), `utility_meter.read` (dashboard visibility),
  // `evidence.manage` / `evidence.read` (the generic BE-07 evidence engine,
  // which is Client-scoped and knows nothing about who is standing in front of
  // which meter), `meter_reading_binding.manage` (BE-10C engineering bindings).
  // Holding this code alone grants NOTHING: every route that accepts it also
  // runs `assertUtilityMeterReadingFieldActor`, so authority still comes from
  // the actor's assignment to the reading's generated task plus BE-02G Building
  // access. No role name is implied or checked.
  { code: 'utility_meter.field.evidence', name: 'Manage Field Utility Meter Reading Evidence' },
  // BE-19A — Tenant Charges
  { code: 'tenant_charge.read', name: 'Read Tenant Charges' },
  { code: 'tenant_charge.manage', name: 'Manage Tenant Charges' },
  // BE-19B — Electricity / Water Bill
  { code: 'utility_bill.read', name: 'Read Utility Bills' },
  { code: 'utility_bill.manage', name: 'Manage Utility Bills' },
  // BE-19C — Service Charge Readiness
  { code: 'service_charge_readiness.read', name: 'Read Service Charge Readiness' },
  { code: 'service_charge_readiness.manage', name: 'Manage Service Charge Readiness' },
  // BE-19D — Tenant Invoice
  { code: 'tenant_invoice.read', name: 'Read Tenant Invoices' },
  { code: 'tenant_invoice.manage', name: 'Manage Tenant Invoices' },
  // BE-19E — Invoice Payment Status
  { code: 'invoice_payment_status.read', name: 'Read Invoice Payment Status' },
  { code: 'invoice_payment_status.manage', name: 'Manage Invoice Payment Status' },
  // BE-19F — Payment Receipt
  { code: 'payment_receipt.read', name: 'Read Payment Receipts' },
  { code: 'payment_receipt.manage', name: 'Manage Payment Receipts' },
  // BE-19G — Vendor / Service Cost
  { code: 'vendor_service_cost.read', name: 'Read Vendor / Service Costs' },
  { code: 'vendor_service_cost.manage', name: 'Manage Vendor / Service Costs' },
  // BE-19H — Basic Expense
  { code: 'basic_expense.read', name: 'Read Basic Expenses' },
  { code: 'basic_expense.manage', name: 'Manage Basic Expenses' },
  // BE-19I — Basic Financial Reporting
  { code: 'basic_financial_reporting.read', name: 'Read Basic Financial Reports' },
  // CR-BE-FIN-01 PART 01 — Operational Budget Foundation
  { code: 'operational_budget.read', name: 'Read Operational Budgets' },
  { code: 'operational_budget.manage', name: 'Manage Operational Budgets' },
  // CR-BE-COMM-VAR-01 PART 02 — overspend override. Deliberately separate from
  // `operational_budget.manage`: administering a budget must not imply the
  // authority to exceed approved spending. Granted to no role by default.
  { code: 'operational_budget.override', name: 'Override Operational Budget Overspend' },
  // BE-20A / BE-20F — Permit Foundation and Approval Authority
  { code: 'permit.read', name: 'Read Permits' },
  { code: 'permit.manage', name: 'Manage Permits' },
  { code: 'permit.approve', name: 'Approve Permits' },
  // CR-BE-RN20-PERMIT-FIELD-01 — Work Permit FIELD execution. A Permit Worker
  // discovers and executes the BE-20K work lifecycle (START / CLOSE) of the
  // permits they are an ACTIVE worker on. Deliberately NOT `permit.read` /
  // `permit.manage` / `permit.approve`: those are permit ADMINISTRATION and
  // approval authority, whereas standing on site executing an already issued
  // permit is FIELD authority, and the two must be grantable / revocable
  // independently — the same split CR-BE-RN11-MATERIAL-FIELD-01 and
  // CR-BE-RN12-METER-FIELD-01 drew. Neither code opens any /permits, /permit-*
  // or /safety-requirements route, and the field routes never accept
  // `permit.manage` as a substitute: field identity (the worker chain) is
  // asserted on every call. Granted to PLATFORM_ADMIN by default (ordinary
  // operational capability), not an exceptional authority.
  { code: 'permit_work_field.read', name: 'Read Field Permit Work' },
  { code: 'permit_work_field.execute', name: 'Execute Field Permit Work' },
  // BE-21A — Incident Foundation
  { code: 'incident.read', name: 'Read Incidents' },
  { code: 'incident.manage', name: 'Manage Incidents' },
  // BE-21B — Operational Incident
  { code: 'operational_incident.read', name: 'Read Operational Incidents' },
  { code: 'operational_incident.manage', name: 'Manage Operational Incidents' },
  // CR-BE-RN18-SAFETY-FIELD-REPORT-01 — Hazard / Near-Miss Field Reporting
  { code: 'safety_field_report.create', name: 'Create Safety Field Reports' },
  { code: 'safety_field_report.read', name: 'Read Safety Field Reports' },
  // CR-BE-RN19-SAFETY-INSPECTION-01 — binding configuration only. Generic
  // mobile Checklist Execution remains the lifecycle authority.
  { code: 'safety_inspection.read', name: 'Read Safety Inspection Bindings' },
  { code: 'safety_inspection.manage', name: 'Manage Safety Inspection Bindings' },
  // BE-21C — Asset Failure / Defect
  { code: 'asset_failure.read', name: 'Read Asset Failures' },
  { code: 'asset_failure.manage', name: 'Manage Asset Failures' },
  // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 01 — field reporting of an unsafe
  // condition. Deliberately separate from `asset_failure.manage`: recording a
  // hazard a technician can SEE is not authority to administer the record
  // afterwards. Granted to PLATFORM_ADMIN by default — field reporting is an
  // ordinary operational capability, not the exceptional authority class that
  // UNASSIGNED_BY_DEFAULT_PERMISSION_CODES exists for.
  { code: 'asset_failure.report', name: 'Report Unsafe Asset Conditions' },
  // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — Asset operational state (RN-10).
  // Deliberately separate from `asset.manage`: declaring equipment
  // OUT_OF_SERVICE / ISOLATED / SHUT_DOWN is a SAFETY decision, not Asset
  // master-data administration, and the two must be grantable and revocable
  // independently. Reading the state needs no new code (`asset.read`).
  // Granted to PLATFORM_ADMIN by default.
  {
    code: 'asset_operational_state.manage',
    name: 'Manage Asset Operational State',
  },
  // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 03 — governed RETURN_TO_SERVICE.
  // A THIRD, separate code. Taking equipment out of service and putting it back
  // are not the same authority: returning an Asset to service asserts that the
  // hazard is cleared, so it is granted and revoked independently of
  // `asset_operational_state.manage` (and, like it, of `asset.manage` and the
  // whole `asset_failure.*` family). Granted to PLATFORM_ADMIN by default —
  // an ordinary operational authority, not the exceptional class that
  // UNASSIGNED_BY_DEFAULT_PERMISSION_CODES exists for. There is no technician
  // or mobile grant: caller-specific mobile authority is a later PART.
  {
    code: 'asset_operational_state.return_to_service',
    name: 'Return Asset to Service',
  },
  // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 04 — mobile RN-10 operational-state
  // READ. Gates `GET /mobile/assets/{assetId}/operational-state`, which
  // returns the canonical PART 02 operational-state view plus the
  // caller-specific `availableActions` snapshot. A dedicated code rather
  // than `asset.read`: that surface discloses the caller's own safety
  // authorities as executable affordances, which is a distinct capability
  // grant. No role name is involved — application roles (technician, BM,
  // supervisor, …) are provisioned to this code by policy/configuration,
  // exactly like every other code in this catalogue. Granted to
  // PLATFORM_ADMIN by default, following the existing convention for the
  // other RN-10 operational codes (it is not the exceptional authority class
  // that UNASSIGNED_BY_DEFAULT_PERMISSION_CODES exists for).
  {
    code: 'asset_operational_state.read',
    name: 'Read Mobile Asset Operational State',
  },
  // BE-21D — Finding Escalation
  { code: 'finding_escalation.read', name: 'Read Finding Escalations' },
  { code: 'finding_escalation.manage', name: 'Manage Finding Escalations' },
  // BE-21E — Immediate Action
  { code: 'immediate_action.read', name: 'Read Immediate Actions' },
  { code: 'immediate_action.manage', name: 'Manage Immediate Actions' },
  // BE-21F — Investigation Readiness. Read-only by design: readiness is
  // computed, never stored, so there is nothing to manage.
  {
    code: 'investigation_readiness.read',
    name: 'Read Investigation Readiness',
  },
  // BE-21G — Corrective Action
  { code: 'corrective_action.read', name: 'Read Corrective Actions' },
  { code: 'corrective_action.manage', name: 'Manage Corrective Actions' },
  // BE-21H — Corrective Action Responsible Person
  {
    code: 'corrective_action_responsibility.read',
    name: 'Read Corrective Action Responsible Persons',
  },
  {
    code: 'corrective_action_responsibility.manage',
    name: 'Manage Corrective Action Responsible Persons',
  },
  // BE-21J — Corrective Action Verification. Separate from
  // `corrective_action.manage` on purpose: doing the work and confirming it
  // are different authorities.
  {
    code: 'corrective_action_verification.read',
    name: 'Read Corrective Action Verifications',
  },
  {
    code: 'corrective_action_verification.manage',
    name: 'Manage Corrective Action Verifications',
  },
  // BE-21K — Incident Closure. Separate from `incident.manage` on purpose:
  // reporting or editing an Incident is not authority to seal the record.
  { code: 'incident_closure.read', name: 'Read Incident Closure Status' },
  { code: 'incident_closure.manage', name: 'Close Incidents' },
  // BE-22A — Document Foundation (ONE shared foundation for INTERNAL/TENANT/VENDOR)
  { code: 'document.read', name: 'Read Documents' },
  { code: 'document.manage', name: 'Manage Documents' },
  { code: 'document.approve', name: 'Approve Documents' },
  { code: 'document.archive', name: 'Archive and Restore Documents' },
  // CR-BE-BAST-01 — narrow authority for canonical BAST decisions.
  { code: 'bast.accept', name: 'Accept or Reject BAST' },
  // BE-23F1 — Security Patrol & Activity KPI (read-only reporting)
  { code: 'security_patrol_kpi.read', name: 'Read Security Patrol Activity KPI' },
  // BE-23F2 — Security Finding / Incident / Handover KPI (read-only reporting)
  {
    code: 'security_finding_incident_kpi.read',
    name: 'Read Security Finding and Incident KPI',
  },
  // BE-23G — Workforce KPI (read-only reporting)
  { code: 'workforce_kpi.read', name: 'Read Workforce KPI' },
  // BE-23H — Vendor / Tenant KPI (read-only reporting)
  { code: 'vendor_tenant_kpi.read', name: 'Read Vendor and Tenant KPI' },
  // BE-23I — Utility KPI (read-only reporting)
  { code: 'utility_kpi.read', name: 'Read Utility KPI' },
  // BE-23J — Reporting Export Dataset (read-only projection)
  { code: 'reporting_export.read', name: 'Read Reporting Export Datasets' },
  // CR-BE-EXP-01 PART 01 — durable export request/archive authority.
  { code: 'report_export.generate', name: 'Generate Report Exports' },
  { code: 'report_archive.read', name: 'Read Report Archives' },
  // BE-24 PART 01 — Management & Owner read-model scope foundation.
  {
    code: 'management_read_model.read',
    name: 'Read Management and Owner Read Models',
  },
  // CR-BE-API-01 PART 04 — Shared operational permission alignment.
  // Dedicated codes for the checklist / task / evidence / schedule / review /
  // UOM / operational-event surfaces that previously reused form_template.*.
  { code: 'checklist.read', name: 'Read Checklists' },
  { code: 'checklist.manage', name: 'Manage Checklists' },
  { code: 'task.read', name: 'Read Tasks' },
  { code: 'task.manage', name: 'Manage Tasks' },
  { code: 'evidence.read', name: 'Read Evidence' },
  { code: 'evidence.manage', name: 'Manage Evidence' },
  { code: 'schedule.read', name: 'Read Schedules' },
  { code: 'schedule.manage', name: 'Manage Schedules' },
  { code: 'review.read', name: 'Read Reviews' },
  { code: 'review.manage', name: 'Manage Reviews' },
  { code: 'uom.read', name: 'Read Units of Measure' },
  { code: 'uom.manage', name: 'Manage Units of Measure' },
  { code: 'operational_event.read', name: 'Read Operational Events' },
  // BE-27A — Client-scoped configuration foundation.
  { code: 'client_configuration.read', name: 'Read Client Configuration' },
  { code: 'client_configuration.manage', name: 'Manage Client Configuration' },
  // BE-27B — Building-scoped configuration foundation.
  { code: 'building_configuration.read', name: 'Read Building Configuration' },
  { code: 'building_configuration.manage', name: 'Manage Building Configuration' },
  // BE-27C — Client/Building scoped Module configuration.
  { code: 'module_configuration.read', name: 'Read Module Configuration' },
  { code: 'module_configuration.manage', name: 'Manage Module Configuration' },
  // BE-27D — Feature Entitlement configuration.
  { code: 'feature_entitlement_configuration.read', name: 'Read Feature Entitlement Configuration' },
  { code: 'feature_entitlement_configuration.manage', name: 'Manage Feature Entitlement Configuration' },
  // BE-27E — Navigation Registry.
  { code: 'navigation_registry.read', name: 'Read Navigation Registry' },
  { code: 'navigation_registry.manage', name: 'Manage Navigation Registry' },
  // BE-27F — Workspace Registry.
  { code: 'workspace_registry.read', name: 'Read Workspace Registry' },
  { code: 'workspace_registry.manage', name: 'Manage Workspace Registry' },
  // BE-27G — Dashboard / Widget Configuration.
  { code: 'dashboard_configuration.read', name: 'Read Dashboard Configuration' },
  { code: 'dashboard_configuration.manage', name: 'Manage Dashboard Configuration' },
  // BE-26B — Notification template foundation (platform configuration).
  { code: 'notification_template.read', name: 'Read Notification Templates' },
  { code: 'notification_template.manage', name: 'Manage Notification Templates' },
  // BE-26D — Notification event subscription foundation (platform configuration).
  { code: 'notification_subscription.read', name: 'Read Notification Subscriptions' },
  { code: 'notification_subscription.manage', name: 'Manage Notification Subscriptions' },
  // BE-26H — Notification reminder foundation (platform configuration).
  { code: 'notification_reminder.read', name: 'Read Notification Reminders' },
  { code: 'notification_reminder.manage', name: 'Manage Notification Reminders' },
  // BE-26I — Notification escalation foundation (platform configuration).
  { code: 'notification_escalation.read', name: 'Read Notification Escalations' },
  { code: 'notification_escalation.manage', name: 'Manage Notification Escalations' },
  // BE-26J — Notification secure link foundation (platform configuration).
  { code: 'notification_secure_link.read', name: 'Read Notification Secure Links' },
  { code: 'notification_secure_link.manage', name: 'Manage Notification Secure Links' },
  // CR-BE-MOB-03 PART 01 — Workforce (BE-03C) read permission. The BE-03C /
  // BE-03F / BE-03I2 / BE-23G supervisor team-workload routes (workforce
  // profiles, reporting lines, workforce reporting, workforce KPI) have always
  // required these codes; `workforce.read` was never seeded, so no role could
  // be granted it (same defect class as the vendor_invoice codes above).
  // `workforce_kpi.read` is already registered above. `workforce.manage` and
  // the rest of the BE-03A/B/E catalogue codes remain out of scope for this
  // publish-first PART.
  { code: 'workforce.read', name: 'Read Workforce Profiles' },
  // CR-BE-CONFIG-PERM-01 — organizational-structure (BE-03A/B/D1/E) catalogue
  // codes plus the BE-03C Workforce management side. This closes the deferral
  // recorded immediately above.
  //
  // The BE-03A Organization and Department routers, the BE-03B Team and
  // Position routers, the BE-03D1 Skill catalog router (also reused by
  // BE-03I workforce skills) and the BE-03E Shift router (also reused by
  // workforce shifts) have always required exactly these codes, as has the
  // `workforce.manage` write side reused by BE-03F reporting lines, BE-03G
  // building assignments and BE-03H external affiliations. None was ever
  // seeded, so under default-deny RBAC no role could be granted them and every
  // one of those routes was unreachable — the same defect class as
  // `workforce.read` and the `vendor_invoice.*` codes above.
  //
  // Registration only. Each spelling below is the exact string already passed
  // to requirePermission(...) by the mounted router: no route, endpoint,
  // workflow or authorization semantic changes, no alias is introduced, and no
  // capability is implied beyond what those routers already implement.
  // `workforce.read` already exists above and is deliberately NOT repeated.
  //
  // These are ordinary organizational master-data administration codes, not
  // exceptional financial/commercial authorities, so they follow the default
  // catalogue rule (granted to PLATFORM_ADMIN by the seed loop below) and are
  // NOT added to UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.
  // BE-03A — Organization
  { code: 'organization.read', name: 'Read Organizations' },
  { code: 'organization.manage', name: 'Manage Organizations' },
  // BE-03A — Department
  { code: 'department.read', name: 'Read Departments' },
  { code: 'department.manage', name: 'Manage Departments' },
  // BE-03B — Team
  { code: 'team.read', name: 'Read Teams' },
  { code: 'team.manage', name: 'Manage Teams' },
  // BE-03B — Position (organizational label only; never alters BE-01 RBAC)
  { code: 'position.read', name: 'Read Positions' },
  { code: 'position.manage', name: 'Manage Positions' },
  // BE-03C — Workforce Profile, management side (read side registered above)
  { code: 'workforce.manage', name: 'Manage Workforce Profiles' },
  // BE-03D1 — Skill Catalog (Client-scoped master/reference only)
  { code: 'skill.read', name: 'Read Skills' },
  { code: 'skill.manage', name: 'Manage Skills' },
  // BE-03E — Shift (Building-scoped definition; also gated by BE-02G
  // requireBuildingAccess on the Building-nested routes)
  { code: 'shift.read', name: 'Read Shifts' },
  { code: 'shift.manage', name: 'Manage Shifts' },
  // CR-BE-MOB-05 PART 02 — Workforce attendance self-service. `attendance.manage`
  // gates the worker's own clock-in / clock-out; `attendance.read` gates the
  // worker's own current attendance status. Both are self-service codes —
  // there is deliberately no attendance administration surface.
  { code: 'attendance.read', name: 'Read Own Attendance' },
  { code: 'attendance.manage', name: 'Manage Own Attendance (Clock In/Out)' },
  // CR-BE-MOB-05 PART 03 — Security operational logbook. `security_logbook.read`
  // gates listing/detail of logbook entries; `security_logbook.manage` gates
  // creating entries and updating OPEN ones. Both are Building-scoped via
  // BE-02F/G; no logbook administration surface exists.
  { code: 'security_logbook.read', name: 'Read Security Logbook Entries' },
  { code: 'security_logbook.manage', name: 'Manage Security Logbook Entries' },
  // CR-BE-INTEG-01 PART 02 — Integration webhook endpoint administration.
  // Dedicated codes (governance §10): no existing permission covers external
  // endpoint + signing-secret administration, and reusing configuration codes
  // would let any config editor mint outbound URLs and secrets (SSRF /
  // exfiltration privilege escalation). `integration_webhook.read` gates the
  // secret-free endpoint reads (and, from PART 06, delivery history);
  // `integration_webhook.manage` gates create/update/deactivate and secret
  // rotation. Client isolation stays with BE-02G context scope.
  { code: 'integration_webhook.read', name: 'Read Integration Webhook Endpoints' },
  { code: 'integration_webhook.manage', name: 'Manage Integration Webhook Endpoints' },
  // CR-BE-FX-01 PART 02 — FX Rate Authority governance.
  //
  // Dedicated codes (governance §15). `fx_rate.manage` is deliberately SPLIT
  // from `fx_rate.approve`: manage may only PROPOSE a rate (PENDING_APPROVAL),
  // which is what makes the maker-checker rule enforceable rather than
  // advisory. A caller holding `fx_rate.manage` alone can never make a rate
  // usable.
  //
  // There is deliberately NO `fx_rate.create`: this repository has no `.create`
  // permission anywhere (441 `.read` / 361 `.manage` registrations), so proposing
  // a rate uses the established `.manage` verb rather than inventing a new one.
  { code: 'fx_rate.read', name: 'Read FX Rates' },
  { code: 'fx_rate.manage', name: 'Manage FX Rates (Propose)' },
  { code: 'fx_rate.approve', name: 'Approve, Reject, Supersede or Deactivate FX Rates' },
  // Client-scoped FX policy. Named after the `client_configuration.*` precedent
  // (BE-27A) for Client-scoped configuration authority. Dedicated rather than
  // reusing `client_configuration.manage`, on the `integration_webhook.*`
  // rationale: a generic configuration code must not be able to switch a
  // Client's FX behaviour, permitted rate sources and inverse-rate rights.
  { code: 'client_fx_policy.read', name: 'Read Client FX Policy' },
  { code: 'client_fx_policy.manage', name: 'Manage Client FX Policy' },
  // CR-BE-SAAS-01 PART 01 — SaaS Control Plane (Gatepro) platform authority.
  //
  // The `platform.*` namespace is the SOLE authority for `/api/v1/platform/*`
  // (frozen contract §3/§8). It is deliberately a separate namespace from
  // every tenant/business permission: no tenant role or business code implies
  // a platform code, and a platform code never appears on a business-plane
  // route. All codes are withheld by default (see
  // UNASSIGNED_BY_DEFAULT_PERMISSION_CODES / D2) — even PLATFORM_ADMIN must
  // receive an explicit, deliberate grant.
  { code: 'platform.customer.read', name: 'Read SaaS Customers' },
  { code: 'platform.customer.manage', name: 'Manage SaaS Customers' },
  { code: 'platform.product.read', name: 'Read SaaS Products & Packages' },
  { code: 'platform.product.manage', name: 'Manage SaaS Products & Packages' },
  { code: 'platform.pricebook.read', name: 'Read SaaS Pricebooks' },
  { code: 'platform.pricebook.manage', name: 'Manage SaaS Pricebooks' },
  { code: 'platform.subscription.read', name: 'Read SaaS Subscriptions' },
  { code: 'platform.subscription.manage', name: 'Manage SaaS Subscriptions' },
  { code: 'platform.provisioning.execute', name: 'Execute Tenant Provisioning' },
  { code: 'platform.billing.read', name: 'Read SaaS Billing' },
  { code: 'platform.billing.manage', name: 'Manage SaaS Billing' },
  { code: 'platform.payment.read', name: 'Read SaaS Payments' },
  { code: 'platform.payment.reconcile', name: 'Reconcile SaaS Payments' },
  { code: 'platform.usage.read', name: 'Read SaaS Usage' },
  { code: 'platform.health.read', name: 'Read Tenant Health' },
  { code: 'platform.reporting.read', name: 'Read Commercial Reporting' },
  { code: 'platform.support.access', name: 'Open Support Sessions' },
  { code: 'platform.configuration.manage', name: 'Manage Platform Configuration' },
  { code: 'platform.audit.read', name: 'Read SaaS Control-Plane Audit' },
];

/**
 * CR-BE-COMM-VAR-01 PART 02 — permission codes that are registered in the
 * catalogue but deliberately granted to NO role by the foundation seed.
 * Exceeding an approved budget is an exceptional financial authority: it must
 * be assigned as a deliberate administrative act, never inherited by being a
 * platform administrator.
 */
export const UNASSIGNED_BY_DEFAULT_PERMISSION_CODES: ReadonlySet<string> = new Set([
  'operational_budget.override',
  'rfq.award',
  // CR-BE-PRICE-01 PART 01 — retroactive correction of an effective price
  // window is an exceptional commercial authority: it must be assigned as a
  // deliberate administrative act, never inherited (governance §14).
  'price_catalog.override',
  // CR-BE-FX-01 PART 02 — approving an exchange rate silently re-states every
  // converted figure derived from it, and the rate table is platform-global in
  // blast radius. It must be assigned as a deliberate administrative act, never
  // inherited by being a platform administrator (governance §15).
  'fx_rate.approve',
  // CR-BE-SAAS-01 PART 01 — the ENTIRE platform.* namespace (frozen D2):
  // Gatepro Control-Plane authority must be granted as a deliberate
  // administrative act. No role — including PLATFORM_ADMIN — inherits any of
  // these by default.
  'platform.customer.read',
  'platform.customer.manage',
  'platform.product.read',
  'platform.product.manage',
  'platform.pricebook.read',
  'platform.pricebook.manage',
  'platform.subscription.read',
  'platform.subscription.manage',
  'platform.provisioning.execute',
  'platform.billing.read',
  'platform.billing.manage',
  'platform.payment.read',
  'platform.payment.reconcile',
  'platform.usage.read',
  'platform.health.read',
  'platform.reporting.read',
  'platform.support.access',
  'platform.configuration.manage',
  'platform.audit.read',
]);

const PLATFORM_ADMIN_ROLE = {
  code: 'PLATFORM_ADMIN',
  name: 'Platform Administrator',
  description: 'Manages identity, roles, and permissions.',
};

export const foundationAccessSeed: Seed = {
  id: 'foundation_access',

  async run(pool: Pool): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const permission of FOUNDATION_PERMISSIONS) {
        await client.query(
          `INSERT INTO permissions (id, code, name, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           ON CONFLICT (code) DO NOTHING`,
          [randomUUID(), permission.code, permission.name],
        );
      }

      await client.query(
        `INSERT INTO roles (id, code, name, description, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')
         ON CONFLICT (code) DO NOTHING`,
        [
          randomUUID(),
          PLATFORM_ADMIN_ROLE.code,
          PLATFORM_ADMIN_ROLE.name,
          PLATFORM_ADMIN_ROLE.description,
        ],
      );

      const roleResult = await client.query<{ id: string }>(
        `SELECT id FROM roles WHERE code = $1`,
        [PLATFORM_ADMIN_ROLE.code],
      );
      const roleId = roleResult.rows[0]?.id;
      if (roleId) {
        for (const permission of FOUNDATION_PERMISSIONS) {
          if (UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(permission.code)) {
            continue;
          }
          await client.query(
            `INSERT INTO role_permission_assignments (id, role_id, permission_id, status)
             SELECT $1, $2, p.id, 'ACTIVE'
             FROM permissions p
             WHERE p.code = $3
             ON CONFLICT (role_id, permission_id) WHERE status = 'ACTIVE' DO NOTHING`,
            [randomUUID(), roleId, permission.code],
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
};
