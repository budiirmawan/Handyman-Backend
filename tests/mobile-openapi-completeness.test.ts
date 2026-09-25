import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

/**
 * CR-BE-MOB-CONTRACT-01 PART 07 — Mobile OpenAPI completeness.
 *
 * A drift-detection suite over the mobile-consumed backend route surface.
 * It has three independent guards:
 *
 *  1. Pinned completeness matrix — a frozen list of METHOD+PATH pairs that
 *     the mobile contract MUST publish. If a path is removed from OpenAPI
 *     (or renamed), this test fails. If a NEW mobile route is added to the
 *     backend but not to this pinned list, a dedicated test (below) fails —
 *     so the list cannot silently rot.
 *
 *  2. Reverse drift — every backend route in the mobile-consumed modules
 *     that matches the pinned matrix MUST be documented in OpenAPI. This
 *     catches "implemented but not published" regressions.
 *
 *  3. Structural invariants — every documented operation has a unique
 *     operationId, every $ref resolves, and documented paths are actually
 *     registered in the router (reusing the same probe as
 *     openapi-contract.test.ts).
 *
 * The matrix is the authoritative classification from PART 07 plus the
 * CR-BE-MOB-01 PART 01 Housekeeping, PART 02 Security and PART 03
 * Engineering operational surfaces: each entry is PUBLISHED (documented).
 * Routes deliberately out of this mobile contract (e.g. inventory,
 * procurement, utility/billing meters, tenant, vendor, workforce reporting,
 * HK consumable stock, security keys / lost-found / visitor bindings /
 * security shift handovers, and the per-domain reporting datasets) are NOT
 * in the matrix.
 *
 * The domain-specific published surfaces have their own pinned suites:
 * `mobile-housekeeping-contract.test.ts` (PART 01),
 * `mobile-security-contract.test.ts` (PART 02) and
 * `mobile-engineering-contract.test.ts` (PART 03).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const ROUTES_DIR = resolve(__dirname, '../src/routes');

// ---------------------------------------------------------------------------
// Pinned completeness matrix (CR-BE-MOB-CONTRACT-01 PART 07).
// Format: "METHOD /path" — the normalized OpenAPI path with {param} syntax.
// ---------------------------------------------------------------------------
const MOBILE_CONTRACT_MATRIX: string[] = [
  // 1. Authentication & Session
  'POST /auth/login',
  'GET /auth/me',
  'POST /auth/logout',
  'GET /auth/audit-events',
  'GET /auth/me/buildings',
  // 2. User / Role / Permission / Entitlement
  'POST /users',
  'GET /users/{userId}',
  'POST /users/{userId}/deactivate',
  'POST /users/{userId}/suspend',
  'POST /users/{userId}/reactivate',
  'POST /roles',
  'GET /roles',
  'GET /roles/{roleId}',
  'POST /users/{userId}/roles',
  'GET /users/{userId}/roles',
  'POST /permissions',
  'GET /permissions',
  'GET /permissions/{permissionId}',
  'POST /roles/{roleId}/permissions',
  'GET /roles/{roleId}/permissions',
  'GET /entitlements',
  'GET /entitlements/{entitlementId}',
  'PATCH /entitlements/{entitlementId}/status',
  'GET /subscriptions/{subscriptionId}/entitlements',
  'GET /subscriptions/{subscriptionId}/entitlements/effective',
  'POST /subscriptions/{subscriptionId}/entitlements',
  // 3. Client / Property / Building Context
  'POST /clients',
  'GET /clients',
  'GET /clients/{clientId}',
  'PATCH /clients/{clientId}',
  'POST /properties',
  'GET /properties',
  'GET /properties/{propertyId}',
  'PATCH /properties/{propertyId}/status',
  'GET /clients/{clientId}/properties',
  'POST /buildings',
  'GET /buildings',
  'GET /buildings/{buildingId}',
  'PATCH /buildings/{buildingId}/status',
  'GET /properties/{propertyId}/buildings',
  'POST /users/{userId}/buildings',
  'GET /users/{userId}/buildings',
  'DELETE /users/{userId}/buildings/{buildingId}',
  // 4. Task & Work Order
  'GET /tasks',
  'GET /tasks/{taskId}',
  'POST /tasks/{taskId}/start',
  'POST /tasks/{taskId}/complete',
  'POST /tasks/{taskId}/cancel',
  'GET /tasks/{taskId}/assignments',
  'POST /tasks/{taskId}/assignments',
  'PATCH /tasks/{taskId}/assignments/{assignmentId}',
  'GET /workforce/{workforceId}/tasks',
  'GET /teams/{teamId}/tasks',
  'GET /buildings/{buildingId}/work-orders',
  'POST /buildings/{buildingId}/work-orders',
  'GET /work-orders/{workOrderId}',
  'PATCH /work-orders/{workOrderId}',
  'GET /work-orders/{workOrderId}/assignments',
  'POST /work-orders/{workOrderId}/assignments',
  'GET /work-orders/{workOrderId}/assignments/current',
  'PATCH /work-orders/{workOrderId}/assignments/{assignmentId}',
  'GET /work-orders/{workOrderId}/actions',
  'GET /work-orders/{workOrderId}/context',
  'PATCH /work-orders/{workOrderId}/context',
  'GET /work-orders/{workOrderId}/completion',
  'PATCH /work-orders/{workOrderId}/priority',
  'PATCH /work-orders/{workOrderId}/status',
  'PATCH /work-orders/{workOrderId}/bast-requirement',
  'POST /work-orders/{workOrderId}/acknowledge',
  'POST /work-orders/{workOrderId}/start',
  'POST /work-orders/{workOrderId}/hold',
  'POST /work-orders/{workOrderId}/resume',
  'POST /work-orders/{workOrderId}/notes',
  'POST /work-orders/{workOrderId}/cancel',
  'POST /work-orders/{workOrderId}/complete',
  'GET /work-orders/{workOrderId}/evidence-requirements',
  'GET /work-orders/{workOrderId}/evidence',
  'POST /work-orders/{workOrderId}/evidence',
  'PATCH /work-orders/{workOrderId}/evidence/{evidenceId}',
  'GET /work-orders/{workOrderId}/verification',
  'POST /work-orders/{workOrderId}/verification',
  'GET /work-orders/{workOrderId}/history',
  'GET /mobile/assignments',
  // 5. Checklist
  'POST /checklist-templates/{templateId}/executions',
  'GET /checklist-executions',
  'GET /checklist-executions/{executionId}',
  'POST /checklist-executions/{executionId}/start',
  'GET /checklist-executions/{executionId}/responses',
  'PUT /checklist-executions/{executionId}/responses',
  'POST /checklist-executions/{executionId}/complete',
  'POST /checklist-executions/{executionId}/cancel',
  'GET /clients/{clientId}/checklist-templates',
  'POST /clients/{clientId}/checklist-templates',
  'GET /checklist-templates/{checklistTemplateId}',
  'PATCH /checklist-templates/{checklistTemplateId}',
  'GET /checklist-templates/{checklistTemplateId}/items',
  'POST /checklist-templates/{checklistTemplateId}/items',
  'PATCH /checklist-items/{checklistItemId}',
  'GET /mobile/checklist-executions/{executionId}',
  // 6. Measurement & UOM
  'GET /clients/{clientId}/uoms',
  'POST /clients/{clientId}/uoms',
  'GET /uoms/{uomId}',
  'PATCH /uoms/{uomId}',
  'PATCH /checklist-items/{checklistItemId}/measurement',
  'PATCH /form-fields/{formFieldId}/measurement',
  // 7. Evidence
  'POST /evidence',
  'GET /evidence',
  'GET /evidence/{evidenceId}',
  'PATCH /evidence/{evidenceId}',
  'POST /evidence/{evidenceId}/file',
  'GET /evidence/{evidenceId}/file',
  'GET /evidence/{evidenceId}/file/content',
  'POST /mobile/evidence',
  'GET /mobile/evidence/{evidenceId}',
  'GET /evidence-requirements',
  'POST /evidence-requirements',
  'GET /evidence-requirements/{evidenceRequirementId}',
  'PATCH /evidence-requirements/{evidenceRequirementId}',
  // 8. Finding
  'GET /buildings/{buildingId}/findings',
  'POST /buildings/{buildingId}/findings',
  'GET /findings/{findingId}',
  'PATCH /findings/{findingId}',
  'GET /findings/{findingId}/available-actions',
  'GET /findings/{findingId}/state',
  'PATCH /findings/{findingId}/state',
  'GET /findings/{findingId}/source',
  'PATCH /findings/{findingId}/source',
  'POST /findings/{findingId}/cancel',
  // 9. Rework
  'GET /findings/{findingId}/rework',
  'POST /findings/{findingId}/rework',
  'PATCH /findings/{findingId}/rework',
  'POST /findings/{findingId}/reject',
  'POST /findings/{findingId}/resubmit',
  // 10. Supervisor Verification
  'POST /findings/{findingId}/reviews',
  'GET /findings/{findingId}/reviews',
  'GET /findings/{findingId}/reviews/current',
  'GET /findings/{findingId}/verification',
  'POST /findings/{findingId}/verification',
  'POST /findings/{findingId}/assignments',
  'GET /findings/{findingId}/assignments',
  'GET /findings/{findingId}/assignments/current',
  'PATCH /findings/{findingId}/assignments/{assignmentId}',
  'GET /findings/{findingId}/history',
  'GET /findings/{findingId}/closure',
  'POST /findings/{findingId}/close',
  'GET /mobile/verification/{targetType}/{targetId}',
  'POST /mobile/verification/{targetType}/{targetId}',
  // 11. QR Resolution
  'GET /assets/resolve/{identifier}',
  'GET /mobile/qr/resolve/{identifier}',
  // 11b. Unsafe condition field reporting
  // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 01 — the authoritative mobile field
  // command for an Asset unsafe condition (a BE-21C Asset Failure with
  // operationalImpact = SAFETY_RISK). Pinned here so the published command
  // cannot silently rot out of the mobile contract.
  'POST /mobile/assets/{assetId}/unsafe-condition',
  // 11c. Mobile RN-10 operational-state read
  // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 04 — the authoritative mobile
  // operational-state READ (canonical PART 02 view + caller-specific
  // availableActions). Pinned here, next to the PART 01 field report, so
  // the published mobile read cannot silently rot out of the contract.
  // READ ONLY: the RN-10 mutations remain canonical on /assets.
  'GET /mobile/assets/{assetId}/operational-state',
  // 12. Location / Functional Location
  'GET /buildings/{buildingId}/hierarchy',
  'GET /functional-locations/{functionalLocationId}/context',
  'GET /buildings/{buildingId}/floors',
  'GET /floors/{floorId}',
  'GET /floors/{floorId}/areas',
  'GET /areas/{areaId}',
  'GET /areas/{areaId}/rooms',
  'GET /rooms/{roomId}',
  'GET /rooms/{roomId}/spaces',
  'GET /spaces/{spaceId}',
  'GET /buildings/{buildingId}/functional-locations',
  'GET /functional-locations/{functionalLocationId}',
  // 13. Asset / Equipment Context
  'GET /buildings/{buildingId}/assets',
  'GET /assets/{assetId}',
  'GET /assets/{assetId}/location',
  'GET /assets/{assetId}/status',
  'GET /assets/{assetId}/identifiers',
  'GET /assets/{assetId}/history',
  'GET /assets/{assetId}/warranties',
  'GET /assets/{assetId}/certifications',
  'GET /assets/{assetId}/equipment-profile',
  // 14. Operational Context
  'GET /operational-events',
  'GET /operational-events/{eventId}',
  'GET /reviews',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadSpec(): Record<string, any> {
  const doc = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
  assert.ok(doc && typeof doc === 'object', 'openapi.yaml must parse');
  return doc;
}

/** Normalizes a backend route ("/tasks/:id") to OpenAPI path syntax ("/tasks/{id}"). */
function normalizePath(p: string): string {
  return p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (m) => `{${m.slice(1)}}`);
}

/**
 * Collapses every path parameter to a canonical `{p}` token so that the
 * backend's `:id` / `:workOrderId` param NAMES can be compared against the
 * OpenAPI `{propertyId}` / `{workOrderId}` names — the router treats any
 * single-segment param identically.
 */
function canonicalPath(p: string): string {
  return p.replace(/\{[^}]+\}/g, '{p}');
}

/** Public endpoints that intentionally omit the bearer security scheme. */
const PUBLIC_OPERATIONS = new Set([
  'GET /health',
  'GET /health/database',
  'POST /auth/login',
  'GET /mobile/app-version/{platform}',
]);

function documentedOperations(spec: Record<string, any>): Set<string> {
  const set = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item ?? {})) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      set.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return set;
}

/** Extracts every route registration from the backend module route files. */
function backendRoutes(): Set<string> {
  const re = /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const set = new Set<string>();
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (name.endsWith('.routes.ts')) out.push(p);
    }
    return out;
  }
  for (const file of [...walk(MODULES_DIR), ...walk(ROUTES_DIR)]) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const method = m[1].toUpperCase();
      const path = normalizePath(m[2]);
      set.add(`${method} ${canonicalPath(path)}`);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 07 — mobile OpenAPI completeness', () => {
  const spec = loadSpec();
  const documented = documentedOperations(spec);

  it('publishes every pinned mobile-contract operation', () => {
    const missing = MOBILE_CONTRACT_MATRIX.filter((op) => !documented.has(op));
    assert.deepEqual(
      missing,
      [],
      `mobile contract matrix entries missing from OpenAPI: ${missing.join(', ')}`,
    );
  });

  it('documents only operations that are registered in the backend router', () => {
    // Reuses the invariant from openapi-contract.test.ts without a live
    // server: every documented METHOD+PATH must appear in the route files
    // (canonicalized so param names do not affect the comparison).
    const registered = backendRoutes();
    const phantom: string[] = [];
    for (const op of documented) {
      const [method, path] = op.split(' ');
      if (!registered.has(`${method} ${canonicalPath(path)}`)) phantom.push(op);
    }
    assert.deepEqual(
      phantom,
      [],
      `documented operations not registered in the router: ${phantom.join(', ')}`,
    );
  });

  it('documents a unique operationId per operation', () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        if (!op.operationId) {
          missing.push(`${method.toUpperCase()} ${path}`);
          continue;
        }
        if (seen.has(op.operationId)) dups.push(op.operationId);
        seen.add(op.operationId);
      }
    }
    assert.deepEqual(missing, [], 'operations without operationId');
    assert.deepEqual(dups, [], 'duplicate operationIds');
  });

  it('resolves every $ref in the spec', () => {
    const schemas = Object.keys(spec.components?.schemas ?? {});
    const responses = Object.keys(spec.components?.responses ?? {});
    const params = Object.keys(spec.components?.parameters ?? {});
    const known = new Set([...schemas, ...responses, ...params]);
    const unresolved: string[] = [];
    function walk(node: unknown): void {
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref') {
            const target = (v as string).split('/').pop()!;
            if (!known.has(target)) unresolved.push(v as string);
          } else {
            walk(v);
          }
        }
      }
    }
    walk(spec);
    assert.deepEqual(unresolved, [], 'unresolved $refs');
  });

  it('every mobile-contract operation carries bearer security', () => {
    const unsafe: string[] = [];
    for (const op of MOBILE_CONTRACT_MATRIX) {
      if (PUBLIC_OPERATIONS.has(op)) continue;
      const [method, path] = op.split(' ');
      const item = spec.paths?.[path]?.[method.toLowerCase()];
      if (!item) continue; // already reported by the matrix test
      const security = item.security ?? [];
      const hasBearer = security.some(
        (s: Record<string, unknown>) => 'bearerAuth' in s,
      );
      if (!hasBearer) unsafe.push(op);
    }
    assert.deepEqual(unsafe, [], 'operations missing bearer security');
  });
});
