/**
 * CR-HM-IAM-BOOTSTRAP-01 — Canonical persona role definitions.
 *
 * These are the ONLY roles the one-time first-owner bootstrap creates. They
 * are deliberately NOT a second permission catalogue: every permission code
 * below must already exist in the authoritative `permissions` table (the
 * foundation seed plus the additive migration registrations such as
 * `handyman.care.building`). The bootstrap fails closed, and rolls back, when
 * any referenced code is missing — it never invents a privilege.
 *
 * Role names grant nothing on their own. `requirePermission` resolves the
 * caller's ACTIVE permission codes through
 * user → user_role_assignments → roles → role_permission_assignments →
 * permissions. Assigning one of these roles therefore grants exactly the
 * listed codes and nothing else.
 *
 * The OWNER is the pre-existing `PLATFORM_ADMIN` role created by the
 * foundation seed. It receives every foundation permission EXCEPT the
 * deliberate-withholding set (`UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`):
 * financial execution, QC management, BAST issuance, Building Customer Care,
 * FX approval, budget override, RFQ award, price override and the entire
 * `platform.*` control plane stay unassigned until an explicit, audited grant.
 * Merely holding the role name never substitutes for a permission.
 *
 * Building/tenant data isolation is NOT weakened by any role here: role
 * assignment only makes a capability reachable. The existing BE-02G context
 * checks (explicit Building assignment under the server-derived Client) still
 * gate every request, and the bootstrap creates no Building assignment.
 */

export const OWNER_ROLE_CODE = 'PLATFORM_ADMIN' as const;

export type CanonicalRoleDefinition = {
  code: string;
  name: string;
  description: string;
  permissions: readonly string[];
};

/**
 * SYSTEM_ADMIN — account administration without authority definition.
 *
 * It can create/inspect users, change account lifecycle, reset passwords,
 * scope users to Buildings and read the authentication audit. It deliberately
 * does NOT hold `role.manage` or `permission.manage`: a System Admin cannot
 * assign any role, mint a new role, attach a permission to a role, or hand out
 * PLATFORM_ADMIN. Role/permission definition and assignment stay with the
 * Owner.
 */
export const SYSTEM_ADMIN_ROLE: CanonicalRoleDefinition = {
  code: 'SYSTEM_ADMIN',
  name: 'System Administrator',
  description:
    'Manages user accounts, existing role assignments and Building scopes; cannot define roles or permissions.',
  permissions: [
    'user.read',
    'user.manage',
    'role.read',
    'permission.read',
    'auth.audit.read',
    'building.read',
    'building.manage',
    'organization.read',
    'workforce.read',
  ],
};

/**
 * CUSTOMER_CARE — the tenant-facing mediation persona.
 *
 * `handyman.care.building` is the dedicated Authority-A capability registered
 * by migration 0450 and withheld from PLATFORM_ADMIN by the foundation seed.
 * Granting it through this canonical role is a deliberate bootstrap act; the
 * runtime still requires an ACTIVE assignment to the exact Building under the
 * server-derived Client.
 *
 * SECURITY HARDENING — the generic `tenant_company.manage` grant is
 * deliberately NOT part of this role. That coarse code is the shared gate for
 * dispatch release/cancel, BAST customer accept/reject/sign-off, customer
 * payment recording, lifecycle triage/diagnosis/referral, inspector
 * assignment and material purchasing. Granting it to a tenant-facing persona
 * would hand over operational and financial mutations that are outside the
 * Customer Care remit. The role keeps `tenant_company.read` (building-scoped
 * reads) and the dedicated Care capability; tenant service-request handling
 * stays under `service_request.manage`, which is its own authoritative code.
 */
export const CUSTOMER_CARE_ROLE: CanonicalRoleDefinition = {
  code: 'CUSTOMER_CARE',
  name: 'Customer Care',
  description:
    'Mediates tenant requests and Handyman care for explicitly assigned Buildings.',
  permissions: [
    'tenant_company.read',
    'handyman.care.building',
    'work_order.read',
    'work_request.read',
    'finding.read',
    'document.read',
    'service_request.read',
    'service_request.manage',
  ],
};

/**
 * OPERATIONS — dispatch and day-to-day operational execution.
 *
 * Financial execution, QC authority, BAST issuance and settlement are NOT
 * included: those are dedicated capabilities with their own withholding
 * rules and must be granted explicitly.
 */
export const OPERATIONS_ROLE: CanonicalRoleDefinition = {
  code: 'OPERATIONS',
  name: 'Operations',
  description:
    'Runs dispatch and operational execution for the Buildings assigned to the account.',
  permissions: [
    'tenant_company.read',
    'tenant_company.manage',
    'work_order.read',
    'work_order.manage',
    'work_request.read',
    'work_request.manage',
    'finding.read',
    'finding.manage',
    'finding.assign',
    'finding.execute',
    'schedule.read',
    'schedule.manage',
    'task.read',
    'task.manage',
    'checklist.read',
    'checklist.manage',
    'vendor.read',
    'vendor.manage',
    'asset.read',
    'asset.manage',
    'inventory_item.read',
    'inventory_item.manage',
    'inventory_stock.read',
    'inventory_stock.manage',
    'material_request.read',
    'material_request.manage',
    'permit.read',
    'permit.manage',
    'document.read',
    'document.manage',
    'evidence.read',
    'evidence.manage',
    'utility_meter.read',
    'utility_meter.manage',
    'workforce.read',
    'service_request.read',
    'engineering.read',
    'safety_field_report.read',
  ],
};

/**
 * MANAGER — read/approve oversight.
 *
 * No operational mutation codes are granted. Approval is limited to the
 * existing dedicated review codes (`finding.review`, `finding.close`,
 * `permit.approve`, `document.approve`); financial authority stays read-only
 * (`handyman.finance.read`) and never includes execution/settlement.
 */
export const MANAGER_ROLE: CanonicalRoleDefinition = {
  code: 'MANAGER',
  name: 'Manager',
  description:
    'Reads management reporting and performs the governed review/approval actions.',
  permissions: [
    'management_read_model.read',
    'report_archive.read',
    'reporting_export.read',
    'report_export.generate',
    'basic_financial_reporting.read',
    'work_order.read',
    'work_request.read',
    'finding.read',
    'finding.review',
    'finding.close',
    'permit.read',
    'permit.approve',
    'document.read',
    'document.approve',
    'vendor.read',
    'asset.read',
    'tenant_company.read',
    'utility_meter.read',
    'inventory_stock.read',
    'service_charge_readiness.read',
    'tenant_invoice.read',
    'rfq.read',
    'price_catalog.read',
    'operational_budget.read',
    'workforce.read',
    'workforce_kpi.read',
    'handyman.finance.read',
    'service_request.read',
    'engineering.read',
  ],
};

/**
 * MOBILE_STAFF — field execution from the mobile browser/app.
 *
 * The field execution surfaces are authentication-only or gated on
 * `tenant_company.read`; their real authority is the CURRENT Crew Lead /
 * assignment / shift binding resolved server-side. This role therefore grants
 * NO `tenant_company.manage` and no dispatch/QC/BAST/finance authority.
 */
export const MOBILE_STAFF_ROLE: CanonicalRoleDefinition = {
  code: 'MOBILE_STAFF',
  name: 'Mobile Staff',
  description:
    'Executes assigned field work, attendance and field evidence from the mobile browser/app.',
  permissions: [
    'tenant_company.read',
    'attendance.read',
    'attendance.manage',
    'form_instance.execute',
    'task.read',
    'checklist.read',
    'work_order.read',
    'utility_meter.field.read',
    'utility_meter.field.record',
    'utility_meter.field.evidence',
    'material_request.field.read',
    'material_request.field.request',
    'material_usage.field.record',
    'safety_field_report.create',
    'safety_field_report.read',
    'security_logbook.read',
    'security_logbook.manage',
    'evidence.read',
  ],
};

export const CANONICAL_ROLE_DEFINITIONS: readonly CanonicalRoleDefinition[] = [
  SYSTEM_ADMIN_ROLE,
  CUSTOMER_CARE_ROLE,
  OPERATIONS_ROLE,
  MANAGER_ROLE,
  MOBILE_STAFF_ROLE,
];

/** Every permission code the bootstrap must find registered before granting. */
export const CANONICAL_ROLE_PERMISSION_CODES: readonly string[] = [
  ...new Set(
    CANONICAL_ROLE_DEFINITIONS.flatMap((role) => role.permissions),
  ),
].sort();
