import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { resolveBuildingsForUser } from '../building-assignments';
import { isValidUuid } from '../clients';
import {
  isRecipientKind,
  type RecipientRule,
  type RecipientScope,
  type RecipientSpec,
  type ResolvedRecipient,
} from './recipient-resolution.types';

/**
 * BE-26C — Recipient resolution service.
 *
 * Resolves notification recipients from the backend's existing context, as
 * deduplicated User identities:
 *
 *   - USER          — an explicit User (must be ACTIVE),
 *   - ROLE          — every ACTIVE User holding an ACTIVE Role,
 *   - PERMISSION    — every ACTIVE User whose effective permission set
 *                     contains the code (same resolver chain as RBAC),
 *   - WORKFORCE     — the User linked to an ACTIVE Workforce Profile,
 *   - TEAM          — the Users linked to a Team's ACTIVE Workforce Profiles,
 *   - TENANT_PIC    — the User linked to ACTIVE Tenant PICs (where linked),
 *   - VENDOR_PIC    — Vendor PICs carry contact data only (no User link),
 *                     so no User recipient is applicable (documented below).
 *
 * Rules honored:
 *   - NO new identity/audience engine — only pre-existing links are followed,
 *   - recipients are deduplicated by User id,
 *   - an optional Client/Building scope filters to Users whose OWN accessible
 *     Building context satisfies it (BE-02F/BE-02G; never a client-supplied
 *     scope shortcut),
 *   - no sending, no event subscription, no provider logic.
 */

type ValidationDetail = { field: string; message: string };

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function requireUuid(value: unknown, field: string, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim().toLowerCase())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function requireCode(
  value: unknown,
  field: string,
  pattern: RegExp,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !pattern.test(value.trim())) {
    details.push({
      field,
      message: `${field} must be a non-empty code matching ${pattern.source}.`,
    });
    return undefined;
  }
  return value.trim();
}

const ROLE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Normalizes + validates a single recipient spec (throwing on malformed). */
function validateSpec(spec: RecipientSpec): RecipientSpec {
  if (typeof spec !== 'object' || spec === null) {
    fail([{ field: 'spec', message: 'Each recipient spec must be an object.' }]);
  }
  if (!isRecipientKind((spec as { kind?: unknown }).kind)) {
    fail([{ field: 'kind', message: 'Recipient spec kind is invalid.' }]);
  }

  const details: ValidationDetail[] = [];
  switch (spec.kind) {
    case 'USER': {
      const userId = requireUuid(spec.userId, 'userId', details);
      if (details.length) fail(details);
      return { kind: 'USER', userId: userId as string };
    }
    case 'ROLE': {
      const roleCode = requireCode(spec.roleCode, 'roleCode', ROLE_CODE_PATTERN, details);
      if (details.length) fail(details);
      return { kind: 'ROLE', roleCode: (roleCode as string).toUpperCase() };
    }
    case 'PERMISSION': {
      const permissionCode = requireCode(
        spec.permissionCode,
        'permissionCode',
        PERMISSION_CODE_PATTERN,
        details,
      );
      if (details.length) fail(details);
      return { kind: 'PERMISSION', permissionCode: (permissionCode as string).toLowerCase() };
    }
    case 'WORKFORCE': {
      const workforceProfileId = requireUuid(spec.workforceProfileId, 'workforceProfileId', details);
      if (details.length) fail(details);
      return { kind: 'WORKFORCE', workforceProfileId: workforceProfileId as string };
    }
    case 'TEAM': {
      const teamId = requireUuid(spec.teamId, 'teamId', details);
      if (details.length) fail(details);
      return { kind: 'TEAM', teamId: teamId as string };
    }
    case 'TENANT_PIC': {
      const hasCompany = spec.tenantCompanyId !== undefined;
      const hasPic = spec.tenantPicId !== undefined;
      if (hasCompany === hasPic) {
        details.push({
          field: 'tenantPic',
          message: 'TENANT_PIC spec requires exactly one of tenantCompanyId or tenantPicId.',
        });
        fail(details);
      }
      if (hasCompany) {
        const tenantCompanyId = requireUuid(spec.tenantCompanyId, 'tenantCompanyId', details);
        if (details.length) fail(details);
        return { kind: 'TENANT_PIC', tenantCompanyId: tenantCompanyId as string };
      }
      const tenantPicId = requireUuid(spec.tenantPicId, 'tenantPicId', details);
      if (details.length) fail(details);
      return { kind: 'TENANT_PIC', tenantPicId: tenantPicId as string };
    }
    case 'VENDOR_PIC': {
      const vendorId = requireUuid(spec.vendorId, 'vendorId', details);
      if (details.length) fail(details);
      return { kind: 'VENDOR_PIC', vendorId: vendorId as string };
    }
    default:
      fail([{ field: 'kind', message: 'Recipient spec kind is invalid.' }]);
  }
}

function validateScope(scope?: RecipientScope): RecipientScope | undefined {
  if (!scope) {
    return undefined;
  }
  const details: ValidationDetail[] = [];
  let clientId: string | undefined;
  let buildingIds: string[] | undefined;

  if (scope.clientId !== undefined) {
    clientId = requireUuid(scope.clientId, 'clientId', details);
  }
  if (scope.buildingIds !== undefined) {
    if (!Array.isArray(scope.buildingIds) || scope.buildingIds.length === 0) {
      details.push({
        field: 'buildingIds',
        message: 'buildingIds must be a non-empty array of UUIDs.',
      });
    } else {
      buildingIds = [];
      for (const value of scope.buildingIds) {
        const buildingId = requireUuid(value, 'buildingIds', details);
        if (buildingId) buildingIds.push(buildingId);
      }
    }
  }

  if (details.length > 0) {
    fail(details);
  }
  return {
    ...(clientId ? { clientId } : {}),
    ...(buildingIds ? { buildingIds } : {}),
  };
}

async function queryUserIds(sql: string, params: unknown[]): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(sql, params);
  return result.rows.map((row) => row.id);
}

/** Resolves candidate (userId, sourceId) rows for a single spec. */
async function resolveSpec(spec: RecipientSpec): Promise<ResolvedRecipient[]> {
  switch (spec.kind) {
    case 'USER': {
      const ids = await queryUserIds(
        `SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE'`,
        [spec.userId],
      );
      return ids.map((userId) => ({ userId, kind: 'USER', sourceId: spec.userId }));
    }
    case 'ROLE': {
      const ids = await queryUserIds(
        `SELECT DISTINCT u.id
           FROM user_role_assignments ura
           JOIN roles r ON r.id = ura.role_id
           JOIN users u ON u.id = ura.user_id
          WHERE r.code = $1
            AND r.status = 'ACTIVE'
            AND ura.status = 'ACTIVE'
            AND u.status = 'ACTIVE'
          ORDER BY u.id ASC`,
        [spec.roleCode],
      );
      return ids.map((userId) => ({ userId, kind: 'ROLE', sourceId: spec.roleCode }));
    }
    case 'PERMISSION': {
      const ids = await queryUserIds(
        `SELECT DISTINCT u.id
           FROM permissions p
           JOIN role_permission_assignments rpa ON rpa.permission_id = p.id
           JOIN roles r ON r.id = rpa.role_id
           JOIN user_role_assignments ura ON ura.role_id = r.id
           JOIN users u ON u.id = ura.user_id
          WHERE p.code = $1
            AND p.status = 'ACTIVE'
            AND rpa.status = 'ACTIVE'
            AND r.status = 'ACTIVE'
            AND ura.status = 'ACTIVE'
            AND u.status = 'ACTIVE'
          ORDER BY u.id ASC`,
        [spec.permissionCode],
      );
      return ids.map((userId) => ({ userId, kind: 'PERMISSION', sourceId: spec.permissionCode }));
    }
    case 'WORKFORCE': {
      const ids = await queryUserIds(
        `SELECT u.id
           FROM workforce_profiles wp
           JOIN users u ON u.id = wp.user_id
          WHERE wp.id = $1
            AND wp.status = 'ACTIVE'
            AND u.status = 'ACTIVE'`,
        [spec.workforceProfileId],
      );
      return ids.map((userId) => ({ userId, kind: 'WORKFORCE', sourceId: spec.workforceProfileId }));
    }
    case 'TEAM': {
      const ids = await queryUserIds(
        `SELECT DISTINCT u.id
           FROM teams t
           JOIN workforce_profiles wp ON wp.team_id = t.id
           JOIN users u ON u.id = wp.user_id
          WHERE t.id = $1
            AND t.status = 'ACTIVE'
            AND wp.status = 'ACTIVE'
            AND u.status = 'ACTIVE'
          ORDER BY u.id ASC`,
        [spec.teamId],
      );
      return ids.map((userId) => ({ userId, kind: 'TEAM', sourceId: spec.teamId }));
    }
    case 'TENANT_PIC': {
      const where = spec.tenantPicId
        ? 'tp.id = $1'
        : 'tp.tenant_company_id = $1';
      const param = spec.tenantPicId ?? spec.tenantCompanyId;
      const ids = await queryUserIds(
        `SELECT DISTINCT u.id
           FROM tenant_pics tp
           JOIN users u ON u.id = tp.user_id
          WHERE ${where}
            AND tp.status = 'ACTIVE'
            AND u.status = 'ACTIVE'
          ORDER BY u.id ASC`,
        [param],
      );
      return ids.map((userId) => ({ userId, kind: 'TENANT_PIC', sourceId: param as string }));
    }
    case 'VENDOR_PIC':
      // Vendor PICs are contact data (name/email/phone) with NO User identity
      // link in the schema. Resolving them to a User would require inventing
      // an identity/audience engine, which BE-26C forbids — so no User
      // recipient is applicable here.
      return [];
    default:
      return [];
  }
}

/**
 * Validates and normalizes a persisted recipient rule ({ specs, scope? }).
 * Reused by BE-26D event subscriptions (and BE-26E delivery) so the rule
 * shape has a single validation authority.
 */
export function parseRecipientRule(raw: unknown): RecipientRule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail([{ field: 'recipientRule', message: 'recipientRule must be an object.' }]);
  }
  const source = raw as Record<string, unknown>;
  const specs = source.specs;
  if (!Array.isArray(specs) || specs.length === 0) {
    fail([{ field: 'recipientRule.specs', message: 'recipientRule.specs must be a non-empty array.' }]);
  }

  const normalizedSpecs = specs.map((spec) =>
    validateSpec(spec as RecipientSpec),
  );
  const scope = validateScope(source.scope as RecipientScope | undefined);

  return {
    specs: normalizedSpecs,
    ...(scope ? { scope } : {}),
  };
}

/**
 * True when a User's OWN accessible Building context satisfies the scope.
 * Reuses the BE-02F resolver (single source of truth); never trusts a
 * client-supplied scope identifier directly.
 */
async function userInScope(userId: string, scope: RecipientScope): Promise<boolean> {
  const contexts = await resolveBuildingsForUser(userId);
  if (contexts.length === 0) {
    return false;
  }

  const wantBuildings = scope.buildingIds ? new Set(scope.buildingIds) : null;
  for (const context of contexts) {
    if (scope.clientId && context.client?.id !== scope.clientId) {
      continue;
    }
    if (wantBuildings && !wantBuildings.has(context.building.id)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Resolves a deduplicated recipient list (User ids) from the given specs,
 * optionally filtered to the Client/Building scope.
 */
export async function resolveRecipients(
  specs: RecipientSpec[],
  scope?: RecipientScope,
): Promise<string[]> {
  const recipients = await resolveRecipientsDetailed(specs, scope);
  return recipients.map((recipient) => recipient.userId);
}

/**
 * Resolves recipients with provenance (kind + sourceId), deduplicated by
 * User id (first occurrence wins for deterministic ordering).
 */
export async function resolveRecipientsDetailed(
  specs: RecipientSpec[],
  scope?: RecipientScope,
): Promise<ResolvedRecipient[]> {
  if (!Array.isArray(specs)) {
    fail([{ field: 'specs', message: 'specs must be an array.' }]);
  }
  const validatedScope = validateScope(scope);

  const seen = new Set<string>();
  const resolved: ResolvedRecipient[] = [];

  for (const rawSpec of specs) {
    const spec = validateSpec(rawSpec);
    const candidates = await resolveSpec(spec);
    for (const candidate of candidates) {
      if (seen.has(candidate.userId)) {
        continue;
      }
      if (validatedScope && !(await userInScope(candidate.userId, validatedScope))) {
        continue;
      }
      seen.add(candidate.userId);
      resolved.push(candidate);
    }
  }

  return resolved;
}

export const recipientResolutionService = {
  resolveRecipients,
  resolveRecipientsDetailed,
};
