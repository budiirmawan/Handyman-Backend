import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { contextAccessService } from '../context-access/context-access.service';
import { permissionService } from '../permissions';
import { workforceSkillRepository } from '../workforce-skills/workforce-skill.repository';
import type { SkillCategory } from '../skills';
import type { ProficiencyLevel } from '../workforce-skills/workforce-skill.types';
import type {
  HandymanWorkerAuthorizedRole,
  HandymanWorkerProfileProjection,
} from './handyman-worker-profile.types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.validation(`${field} must be a valid UUID.`);
  }
  return value;
}

function toIsoOrNull(val: Date | string | null | undefined): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  return new Date(val).toISOString();
}

interface CoreWorkerRow {
  worker_context_id: string;
  worker_code: string;
  worker_status: string;
  client_id: string;
  provider_context_id: string;
  provider_code: string;
  provider_status: string;
  vendor_id: string;
  vendor_status: string;
  organization_id: string;
  organization_code: string;
  organization_name: string;
  workforce_profile_id: string;
  user_id: string;
  employee_code: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  workforce_type: string;
  employment_type: string;
  binding_status: string | null;
  binding_effective_from: Date | string | null;
  binding_effective_until: Date | string | null;
}

/**
 * CR-HM-WORKER-PROFILE-FIX-01 — production-schema core projection.
 *
 * Every column below exists in the canonical migration registry; the
 * projection derives the Mobile contract fields from the authorities that
 * actually model them and NEVER fabricates a column:
 *
 *   workerCode        vendor_workforce_bindings.vendor_personnel_code
 *                     (0060) with workforce_profiles.employee_code (0024)
 *                     as the fallback when the provider binding is absent.
 *   providerCode      vendors.vendor_code (0054) — provider contexts (0384)
 *                     carry no code of their own.
 *   clientId          handyman_worker_contexts.client_id (0385); the profile
 *                     is client-scoped through organization (0020/0024),
 *                     never through a nonexistent profile column.
 *   email / phone     users.email / users.whatsapp_phone (0002/0301). The
 *                     profile master models no contact columns.
 *   employmentType    derived from workforce_profiles.workforce_type
 *                     (0024/0031): EXTERNAL → VENDOR, OUTSOURCED →
 *                     OUTSOURCED, CONTRACT → CONTRACT, else INTERNAL.
 *
 * Client isolation is structural: provider context, vendor and organization
 * are all pinned to wc.client_id, and the profile is pinned through its
 * organization, so a cross-client row can never be projected.
 */
const CORE_WORKER_SELECT = `
  SELECT
    wc.id AS worker_context_id,
    COALESCE(
      NULLIF(btrim(vwb.vendor_personnel_code), ''),
      wp.employee_code
    ) AS worker_code,
    wc.status AS worker_status,
    wc.client_id,
    pc.id AS provider_context_id,
    v.vendor_code AS provider_code,
    pc.status AS provider_status,
    v.id AS vendor_id,
    v.status AS vendor_status,
    o.id AS organization_id,
    o.code AS organization_code,
    o.name AS organization_name,
    wp.id AS workforce_profile_id,
    wp.user_id,
    wp.employee_code,
    wp.full_name,
    u.email AS email,
    u.whatsapp_phone AS phone,
    wp.workforce_type,
    CASE wp.workforce_type
      WHEN 'EXTERNAL' THEN 'VENDOR'
      WHEN 'OUTSOURCED' THEN 'OUTSOURCED'
      WHEN 'CONTRACT' THEN 'CONTRACT'
      ELSE 'INTERNAL'
    END AS employment_type,
    vwb.status AS binding_status,
    vwb.effective_from AS binding_effective_from,
    vwb.effective_until AS binding_effective_until
  FROM handyman_worker_contexts wc
  JOIN workforce_profiles wp
    ON wp.id = wc.workforce_profile_id
  JOIN organizations o
    ON o.id = wp.organization_id
   AND o.client_id = wc.client_id
  JOIN handyman_provider_contexts pc
    ON pc.id = wc.handyman_provider_context_id
   AND pc.client_id = wc.client_id
  JOIN vendors v
    ON v.id = pc.vendor_id
   AND v.client_id = wc.client_id
  LEFT JOIN users u
    ON u.id = wp.user_id
  LEFT JOIN LATERAL (
    SELECT b.status,
           b.effective_from,
           b.effective_until,
           b.vendor_personnel_code
      FROM vendor_workforce_bindings b
     WHERE b.vendor_id = v.id
       AND b.workforce_profile_id = wp.id
     ORDER BY (b.status = 'ACTIVE') DESC, b.created_at DESC
     LIMIT 1
  ) vwb ON TRUE
`;

async function buildWorkerProfileProjection(
  core: CoreWorkerRow,
): Promise<HandymanWorkerProfileProjection> {
  const pool = getPool();
  const now = new Date();

  // 1. Crew memberships & lead designations
  const crewRes = await pool.query<{
    crew_id: string;
    crew_code: string;
    crew_name: string;
    building_id: string | null;
    crew_status: string;
    membership_status: string;
    joined_at: Date | string;
    is_crew_lead: boolean;
  }>(
    // handyman_work_crews (0386) is provider-scoped, NOT building-scoped and
    // carries no code/name fallback or membership join timestamp: the crew
    // building is therefore surfaced as NULL rather than invented, and the
    // membership creation instant is the authoritative "joined at".
    `SELECT
       c.id AS crew_id,
       c.code AS crew_code,
       c.name AS crew_name,
       NULL::uuid AS building_id,
       c.status AS crew_status,
       cm.status AS membership_status,
       cm.created_at AS joined_at,
       (latest_lead.handyman_crew_membership_id = cm.id) AS is_crew_lead
     FROM handyman_crew_memberships cm
     JOIN handyman_work_crews c
       ON c.id = cm.handyman_crew_id
      AND c.client_id = cm.client_id
     LEFT JOIN LATERAL (
       SELECT cl.handyman_crew_membership_id
         FROM handyman_crew_leads cl
        WHERE cl.handyman_crew_id = c.id
          AND cl.client_id = c.client_id
        ORDER BY cl.lead_seq DESC
        LIMIT 1
     ) latest_lead ON TRUE
     WHERE cm.client_id = $1
       AND cm.handyman_worker_context_id = $2
     ORDER BY (cm.status = 'ACTIVE') DESC, cm.created_at DESC`,
    [core.client_id, core.worker_context_id],
  );

  // 2. Building assignments.
  // workforce_building_assignments (0030) models ONLY the profile → building
  // placement plus an optional validity window: it has no client_id,
  // property_id, assignment_role, is_primary or assigned_at column. Client
  // scope is proven structurally through building → property → client (0018),
  // and "primary" is DERIVED from the earliest ACTIVE placement instead of
  // being read from a column that does not exist.
  const bldRes = await pool.query<{
    building_id: string;
    building_code: string;
    building_name: string;
    property_id: string;
    status: string;
    effective_from: Date | string | null;
    effective_until: Date | string | null;
  }>(
    `SELECT
       wba.building_id,
       b.code AS building_code,
       b.name AS building_name,
       b.property_id,
       wba.status,
       wba.effective_from,
       wba.effective_until
     FROM workforce_building_assignments wba
     JOIN buildings b
       ON b.id = wba.building_id
     JOIN properties p
       ON p.id = b.property_id
      AND p.client_id = $1
     WHERE wba.workforce_profile_id = $2
       AND EXISTS (
         SELECT 1
           FROM workforce_profiles wp
           JOIN organizations o
             ON o.id = wp.organization_id
          WHERE wp.id = wba.workforce_profile_id
            AND o.client_id = $1
       )
     ORDER BY (wba.status = 'ACTIVE') DESC, wba.created_at ASC, b.code ASC`,
    [core.client_id, core.workforce_profile_id],
  );
  const primaryBuildingId = bldRes.rows.find((r) => r.status === 'ACTIVE')
    ?.building_id;

  // 3. Inspection appointments & work session counts
  const inspCountsRes = await pool.query<{
    active_count: string;
    completed_count: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE state IN ('CONFIRMED', 'IN_PROGRESS'))::text AS active_count,
       COUNT(*) FILTER (WHERE state = 'COMPLETED')::text AS completed_count
     FROM handyman_visit_appointments
     WHERE client_id = $1
       AND kind = 'INSPECTION'
       AND resource_type = 'INSPECTOR_USER'
       AND resource_id = $2`,
    [core.client_id, core.user_id],
  );
  const activeInspectionsCount = Number(
    inspCountsRes.rows[0]?.active_count ?? 0,
  );
  const completedInspectionsCount = Number(
    inspCountsRes.rows[0]?.completed_count ?? 0,
  );

  let activeWorkSessionsCount = 0;
  let completedWorkSessionsCount = 0;
  try {
    const sessCountsRes = await pool.query<{
      active_count: string;
      completed_count: string;
    }>(
      // handyman_work_sessions (0401) status vocabulary: CHECKED_IN,
      // IN_PROGRESS, PAUSED, MATERIAL_RUN, COMPLETED, CHECKED_OUT. The old
      // 'WORK_COMPLETED' filter matched no legal state; COMPLETED sessions are
      // still non-terminal until CHECKED_OUT.
      `SELECT
         COUNT(*) FILTER (
           WHERE status IN ('CHECKED_IN', 'IN_PROGRESS', 'PAUSED',
                            'MATERIAL_RUN', 'COMPLETED')
         )::text AS active_count,
         COUNT(*) FILTER (WHERE status = 'CHECKED_OUT')::text AS completed_count
       FROM handyman_work_sessions
       WHERE client_id = $1
         AND lead_user_id = $2`,
      [core.client_id, core.user_id],
    );
    activeWorkSessionsCount = Number(sessCountsRes.rows[0]?.active_count ?? 0);
    completedWorkSessionsCount = Number(
      sessCountsRes.rows[0]?.completed_count ?? 0,
    );
  } catch {
    // Table may not be populated in minimal environments
  }

  // 4. Derive authorized roles
  const authorizedRoles: HandymanWorkerAuthorizedRole[] = [];
  const isActiveLead = crewRes.rows.some(
    (r) =>
      r.membership_status === 'ACTIVE' &&
      r.crew_status === 'ACTIVE' &&
      Boolean(r.is_crew_lead),
  );
  const isActiveCrewMember = crewRes.rows.some(
    (r) => r.membership_status === 'ACTIVE' && r.crew_status === 'ACTIVE',
  );
  if (isActiveLead) {
    authorizedRoles.push('PIC_PEKERJAAN');
  }
  if (isActiveCrewMember) {
    authorizedRoles.push('CREW_MEMBER');
  }
  if (activeInspectionsCount > 0 || completedInspectionsCount > 0) {
    authorizedRoles.push('INSPECTOR');
  }

  // 5. Effective skills & skill validity windows.
  // workforce_skill_assignments (0026) is client-agnostic; the skill master
  // (0025) carries client_id. Every skill read is pinned to the worker's
  // client so a stale cross-client assignment can never surface here.
  let effectiveSkills: Awaited<
    ReturnType<typeof workforceSkillRepository.listEffectiveSkills>
  > = [];
  let skillValidityWindows: HandymanWorkerProfileProjection['certificationsAndExpiry']['skillValidityWindows'] =
    [];
  try {
    effectiveSkills = await workforceSkillRepository.listEffectiveSkills(
      core.workforce_profile_id,
      now,
      core.client_id,
    );
    const allSkillRows = await pool.query<{
      skill_id: string;
      code: string;
      name: string;
      proficiency_level: ProficiencyLevel;
      valid_from: Date | null;
      valid_until: Date | null;
    }>(
      `SELECT
         s.id AS skill_id,
         s.code,
         s.name,
         wsa.proficiency_level,
         wsa.valid_from,
         wsa.valid_until
       FROM workforce_skill_assignments wsa
       JOIN skills s
         ON s.id = wsa.skill_id
        AND s.client_id = $2
       WHERE wsa.workforce_profile_id = $1
         AND wsa.status = 'ACTIVE'
       ORDER BY s.code ASC`,
      [core.workforce_profile_id, core.client_id],
    );
    skillValidityWindows = allSkillRows.rows.map((r) => ({
      skillId: r.skill_id,
      skillCode: r.code,
      skillName: r.name,
      proficiencyLevel: r.proficiency_level,
      validFrom: toIsoOrNull(r.valid_from),
      expiresAt: toIsoOrNull(r.valid_until),
      isExpired: Boolean(r.valid_until && new Date(r.valid_until) < now),
    }));
  } catch (error) {
    // A worker without skills (or an environment without the skill tables
    // populated) still yields a valid profile: skills are optional.
    logger.warn('Handyman worker profile skills could not be projected.', {
      operation: 'handyman_worker_profile.skills',
      result: 'degraded',
      errorMessage: error instanceof Error ? error.message : 'unknown error',
    });
    effectiveSkills = [];
    skillValidityWindows = [];
  }

  const serviceCategories = Array.from(
    new Set<SkillCategory>(effectiveSkills.map((s) => s.category)),
  );

  // 6. Provider / employer licenses & certifications
  let providerLicensesAndCertifications: HandymanWorkerProfileProjection['certificationsAndExpiry']['providerLicensesAndCertifications'] =
    [];
  try {
    const licRes = await pool.query<{
      id: string;
      record_type: string;
      name: string;
      number: string;
      issuing_authority: string | null;
      issue_date: Date | string | null;
      expiry_date: Date | string | null;
      status: string;
    }>(
      `SELECT
         id,
         record_type,
         name,
         number,
         issuing_authority,
         issue_date,
         expiry_date,
         status
       FROM vendor_licenses_certifications
       WHERE vendor_id = $1
       ORDER BY (status = 'ACTIVE') DESC, expiry_date ASC NULLS LAST`,
      [core.vendor_id],
    );
    providerLicensesAndCertifications = licRes.rows.map((r) => ({
      id: r.id,
      recordType: r.record_type,
      name: r.name,
      number: r.number,
      issuingAuthority: r.issuing_authority,
      issueDate: toIsoOrNull(r.issue_date),
      expiryDate: toIsoOrNull(r.expiry_date),
      status: r.status,
    }));
  } catch (error) {
    // Certifications are Optional by contract: a provider with no license /
    // certification rows (or no vendor registry row) still returns a valid
    // profile instead of failing the whole projection.
    logger.warn(
      'Handyman worker profile certifications could not be projected.',
      {
        operation: 'handyman_worker_profile.certifications',
        result: 'degraded',
        errorMessage:
          error instanceof Error ? error.message : 'unknown error',
      },
    );
    providerLicensesAndCertifications = [];
  }

  // 7. Relevant operational work-history summary (strictly non-commercial)
  const historyRes = await pool.query<{
    execution_scope_id: string;
    handyman_request_id: string;
    request_code: string;
    title: string;
    building_id: string;
    scope_status: string;
    assignment_status: string;
    is_lead: boolean;
    assigned_at: Date | string;
  }>(
    // handyman_service_requests (0378) models no request_code / title column:
    // the display handle is derived from the request's own authoritative
    // origin_reference (falling back to a deterministic id prefix) and the
    // title from its modeled description.
    `SELECT
       es.id AS execution_scope_id,
       es.handyman_request_id,
       COALESCE(
         NULLIF(btrim(sr.origin_reference), ''),
         'HM-' || upper(substr(es.handyman_request_id::text, 1, 8))
       ) AS request_code,
       COALESCE(
         NULLIF(btrim(sr.description), ''),
         'Handyman Work Order'
       ) AS title,
       es.building_id,
       es.status AS scope_status,
       a.status AS assignment_status,
       (latest_lead.handyman_crew_membership_id = cm.id) AS is_lead,
       a.assigned_at
     FROM handyman_crew_memberships cm
     JOIN handyman_work_crews c
       ON c.id = cm.handyman_crew_id
      AND c.client_id = cm.client_id
     JOIN handyman_execution_scope_assignments a
       ON a.handyman_crew_id = c.id
      AND a.client_id = c.client_id
     JOIN handyman_execution_scopes es
       ON es.id = a.execution_scope_id
      AND es.client_id = a.client_id
     JOIN handyman_service_requests sr
       ON sr.id = es.handyman_request_id
      AND sr.client_id = es.client_id
     LEFT JOIN LATERAL (
       SELECT cl.handyman_crew_membership_id
         FROM handyman_crew_leads cl
        WHERE cl.handyman_crew_id = c.id
          AND cl.client_id = c.client_id
        ORDER BY cl.lead_seq DESC
        LIMIT 1
     ) latest_lead ON TRUE
     WHERE cm.client_id = $1
       AND cm.handyman_worker_context_id = $2
     ORDER BY a.assigned_at DESC, es.id ASC
     LIMIT 10`,
    [core.client_id, core.worker_context_id],
  );

  const countRes = await pool.query<{ total_count: string }>(
    `SELECT COUNT(DISTINCT a.execution_scope_id)::text AS total_count
       FROM handyman_crew_memberships cm
       JOIN handyman_execution_scope_assignments a
         ON a.handyman_crew_id = cm.handyman_crew_id
        AND a.client_id = cm.client_id
      WHERE cm.client_id = $1
        AND cm.handyman_worker_context_id = $2`,
    [core.client_id, core.worker_context_id],
  );
  const assignedExecutionScopesCount = Number(
    countRes.rows[0]?.total_count ?? 0,
  );

  return {
    workerIdentity: {
      userId: core.user_id,
      workforceProfileId: core.workforce_profile_id,
      workerContextId: core.worker_context_id,
      workerCode: core.worker_code,
      employeeCode: core.employee_code,
      fullName: core.full_name,
      email: core.email,
      phone: core.phone,
      workforceType: core.workforce_type,
      employmentType: core.employment_type,
      workerStatus: core.worker_status,
    },
    providerAssociation: {
      clientId: core.client_id,
      providerContextId: core.provider_context_id,
      providerCode: core.provider_code,
      providerStatus: core.provider_status,
      vendorId: core.vendor_id,
      vendorStatus: core.vendor_status,
      organizationId: core.organization_id,
      organizationCode: core.organization_code,
      organizationName: core.organization_name,
      bindingStatus: core.binding_status,
      bindingEffectiveFrom: toIsoOrNull(core.binding_effective_from),
      bindingEffectiveUntil: toIsoOrNull(core.binding_effective_until),
    },
    roleAndAssignmentContext: {
      authorizedRoles,
      crewMemberships: crewRes.rows.map((r) => ({
        crewId: r.crew_id,
        crewCode: r.crew_code,
        crewName: r.crew_name,
        buildingId: r.building_id,
        crewStatus: r.crew_status,
        membershipStatus: r.membership_status,
        isCrewLead: Boolean(r.is_crew_lead),
        joinedAt: toIsoOrNull(r.joined_at) ?? now.toISOString(),
      })),
      buildingAssignments: bldRes.rows.map((r) => ({
        buildingId: r.building_id,
        buildingCode: r.building_code,
        buildingName: r.building_name,
        propertyId: r.property_id,
        // A workforce building placement carries no role column (0030); the
        // contract value is the Handyman placement category, not row data.
        assignmentRole: 'HANDYMAN',
        // Derived: the earliest ACTIVE placement is the primary one. Only a
        // real placement is ever flagged, never an inactive history row.
        isPrimary:
          r.status === 'ACTIVE' && r.building_id === primaryBuildingId,
        status: r.status,
        effectiveFrom: toIsoOrNull(r.effective_from),
        effectiveUntil: toIsoOrNull(r.effective_until),
      })),
    },
    skillsAndCategories: {
      serviceCategories,
      effectiveSkills: effectiveSkills.map((s) => ({
        skillId: s.skillId,
        code: s.code,
        name: s.name,
        category: s.category,
        proficiencyLevel: s.proficiencyLevel,
        validFrom: toIsoOrNull(s.validFrom),
        validUntil: toIsoOrNull(s.validUntil),
      })),
    },
    certificationsAndExpiry: {
      individualCertificateNumberModeled: false,
      skillValidityWindows,
      providerLicensesAndCertifications,
    },
    workHistorySummary: {
      assignedExecutionScopesCount,
      activeWorkSessionsCount,
      completedWorkSessionsCount,
      activeInspectionsCount,
      completedInspectionsCount,
      recentWorkOrders: historyRes.rows.map((r) => ({
        executionScopeId: r.execution_scope_id,
        handymanRequestId: r.handyman_request_id,
        requestCode: r.request_code,
        title: r.title,
        buildingId: r.building_id,
        scopeStatus: r.scope_status,
        assignmentStatus: r.assignment_status,
        roleInJob: r.is_lead ? 'PIC_PEKERJAAN' : 'CREW_MEMBER',
        assignedAt: toIsoOrNull(r.assigned_at) ?? now.toISOString(),
      })),
    },
  };
}

/**
 * Self profile projection: GET /handyman/field/me/profile
 */
export async function readMyHandymanWorkerProfileProjection(
  actorUserId: string,
): Promise<HandymanWorkerProfileProjection> {
  const pool = getPool();
  const res = await pool.query<CoreWorkerRow>(
    `${CORE_WORKER_SELECT}
     WHERE wp.user_id = $1
     ORDER BY (wc.status = 'ACTIVE') DESC, wc.created_at DESC
     LIMIT 1`,
    [actorUserId],
  );
  const core = res.rows[0];
  if (!core) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_WORKER_PROFILE_NOT_FOUND,
      message: 'No Handyman worker profile found for the authenticated user.',
    });
  }

  const canAccessClient = await contextAccessService.canAccessClient(
    actorUserId,
    core.client_id,
  );
  if (!canAccessClient) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.BUILDING_ACCESS_DENIED,
      message: 'Access to the worker profile client context is denied.',
    });
  }

  return buildWorkerProfileProjection(core);
}

/**
 * Scoped profile projection by workerContextId:
 * GET /handyman/field/workers/:workerContextId/profile
 */
export async function readHandymanWorkerProfileByContextId(
  actorUserId: string,
  workerContextId: string,
): Promise<HandymanWorkerProfileProjection> {
  const validContextId = assertUuid(workerContextId, 'workerContextId');
  const pool = getPool();
  const res = await pool.query<CoreWorkerRow>(
    `${CORE_WORKER_SELECT}
     WHERE wc.id = $1
     LIMIT 1`,
    [validContextId],
  );
  const core = res.rows[0];
  if (!core) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_WORKER_PROFILE_NOT_FOUND,
      message: 'Handyman worker context not found.',
    });
  }

  const canAccessClient = await contextAccessService.canAccessClient(
    actorUserId,
    core.client_id,
  );
  if (!canAccessClient) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.BUILDING_ACCESS_DENIED,
      message: 'Access to the requested worker client context is denied.',
    });
  }

  if (core.user_id !== actorUserId) {
    // Check if actor is Operations/Customer Care or an active Crew Lead of this worker's crew
    const perms = await permissionService.resolvePermissionsForUser(actorUserId);
    const hasOpsRead =
      perms.includes('tenant_company.read') ||
      perms.includes('tenant_company.manage');

    if (!hasOpsRead) {
      const crewLeadCheck = await pool.query<{ crew_id: string }>(
        `SELECT cm_target.handyman_crew_id AS crew_id
           FROM handyman_crew_memberships cm_target
           JOIN handyman_work_crews c
             ON c.id = cm_target.handyman_crew_id
            AND c.client_id = cm_target.client_id
            AND c.status = 'ACTIVE'
           JOIN LATERAL (
             SELECT cl.handyman_crew_membership_id
               FROM handyman_crew_leads cl
              WHERE cl.handyman_crew_id = c.id
                AND cl.client_id = c.client_id
              ORDER BY cl.lead_seq DESC
              LIMIT 1
           ) latest_lead ON TRUE
           JOIN handyman_crew_memberships cm_lead
             ON cm_lead.id = latest_lead.handyman_crew_membership_id
            AND cm_lead.status = 'ACTIVE'
           JOIN handyman_worker_contexts wc_lead
             ON wc_lead.id = cm_lead.handyman_worker_context_id
            AND wc_lead.status = 'ACTIVE'
           JOIN workforce_profiles wp_lead
             ON wp_lead.id = wc_lead.workforce_profile_id
            AND wp_lead.status = 'ACTIVE'
          WHERE cm_target.client_id = $1
            AND cm_target.handyman_worker_context_id = $2
            AND cm_target.status = 'ACTIVE'
            AND wp_lead.user_id = $3
          LIMIT 1`,
        [core.client_id, core.worker_context_id, actorUserId],
      );

      if (!crewLeadCheck.rows[0]) {
        throw new AppError({
          statusCode: 403,
          code: ERROR_CODES.HANDYMAN_WORKER_PROFILE_FORBIDDEN,
          message:
            'Actor is not authorized to read this Handyman worker profile.',
        });
      }
    }
  }

  return buildWorkerProfileProjection(core);
}
