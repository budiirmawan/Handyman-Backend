import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';

/**
 * CR-BE-CONFIG-PERM-01 — Configuration Permission Registry Closure.
 *
 * Focused registry-integrity suite (static; no database, no HTTP).
 *
 * Defect under test: thirteen permission codes were enforced by mounted
 * production routers but absent from FOUNDATION_PERMISSIONS and from every
 * permission seed/migration insertion. Under the default-deny resolver in
 * `src/modules/auth/rbac.middleware.ts` an unregistered code can never appear
 * in `resolvePermissionsForUser(...)`, so those routes were unreachable by any
 * role — including PLATFORM_ADMIN.
 *
 * This CR registers the codes only. It changes no route, no endpoint, no
 * workflow and no authorization semantic. The guards below pin that boundary:
 *
 *  A. the 13 codes exist in the catalogue exactly once each;
 *  B–H. every requirePermission(...) code enforced by the organization,
 *       department, position, team, shift, skill and workforce routers
 *       resolves against the catalogue;
 *  I. `workforce.read` was NOT invented (it pre-existed; still exactly once);
 *  J. no `configuration.*` umbrella permission was introduced;
 *  K. no wildcard / super-admin bypass was introduced, and the RBAC resolver
 *     still matches codes exactly;
 *  L. unrelated permission codes and the default-assignment policy are
 *     unchanged.
 *
 * OpenAPI reconciliation is deliberately out of scope: registering a permission
 * does not publish a route.
 */

const SRC_DIR = resolve(__dirname, '../src');
const MODULES_DIR = join(SRC_DIR, 'modules');
const ROUTES_DIR = join(SRC_DIR, 'routes');
const RBAC_MIDDLEWARE_PATH = join(SRC_DIR, 'modules/auth/rbac.middleware.ts');

/** The exact 13 codes this CR registers. Spelling is the enforced spelling. */
const REGISTERED_BY_THIS_CR = [
  'organization.read',
  'organization.manage',
  'department.read',
  'department.manage',
  'position.read',
  'position.manage',
  'team.read',
  'team.manage',
  'shift.read',
  'shift.manage',
  'skill.read',
  'skill.manage',
  'workforce.manage',
] as const;

/**
 * Domain → the mounted routers that enforce that domain's codes.
 * Shift and Skill are reused by the workforce-* routers; the Workforce codes
 * are reused by reporting lines, building assignments, external affiliations,
 * workforce reporting and vendor workforce — all of which must resolve too.
 */
const DOMAIN_ROUTE_FILES: Record<string, readonly string[]> = {
  organization: ['organizations/organization.routes.ts'],
  department: ['departments/department.routes.ts'],
  position: ['positions/position.routes.ts'],
  team: ['teams/team.routes.ts'],
  shift: ['shifts/shift.routes.ts', 'workforce-shifts/workforce-shift.routes.ts'],
  skill: ['skills/skill.routes.ts', 'workforce-skills/workforce-skill.routes.ts'],
  workforce: [
    'workforce/workforce.routes.ts',
    'external-workforce/external-workforce.routes.ts',
    'workforce-building-assignments/workforce-building-assignment.routes.ts',
    'workforce-reporting-lines/workforce-reporting-line.routes.ts',
    'workforce-reporting/workforce-reporting.routes.ts',
    'vendor-workforce/vendor-workforce.routes.ts',
  ],
};

/** Expected enforced code per domain, so a silently dropped guard fails. */
const DOMAIN_EXPECTED_CODES: Record<string, readonly string[]> = {
  organization: ['organization.read', 'organization.manage'],
  department: ['department.read', 'department.manage'],
  position: ['position.read', 'position.manage'],
  team: ['team.read', 'team.manage'],
  shift: ['shift.read', 'shift.manage'],
  skill: ['skill.read', 'skill.manage'],
  workforce: ['workforce.read', 'workforce.manage'],
};

const CATALOGUE = FOUNDATION_PERMISSIONS.map((permission) => permission.code);
const CATALOGUE_SET = new Set(CATALOGUE);
const NAME_BY_CODE = new Map(
  FOUNDATION_PERMISSIONS.map((permission) => [permission.code, permission.name]),
);

/** Pre-existing codes that must survive untouched (guard L). */
const UNRELATED_PINNED: Record<string, string> = {
  'user.read': 'Read Users',
  'user.manage': 'Manage Users',
  'role.read': 'Read Roles',
  'role.manage': 'Manage Roles',
  'permission.read': 'Read Permissions',
  'permission.manage': 'Manage Permissions',
  'workforce.read': 'Read Workforce Profiles',
  'workforce_kpi.read': 'Read Workforce KPI',
  'attendance.read': 'Read Own Attendance',
  'attendance.manage': 'Manage Own Attendance (Clock In/Out)',
  'security_logbook.read': 'Read Security Logbook Entries',
  'security_logbook.manage': 'Manage Security Logbook Entries',
  'integration_webhook.read': 'Read Integration Webhook Endpoints',
  'integration_webhook.manage': 'Manage Integration Webhook Endpoints',
  'fx_rate.read': 'Read FX Rates',
  'fx_rate.manage': 'Manage FX Rates (Propose)',
  'fx_rate.approve': 'Approve, Reject, Supersede or Deactivate FX Rates',
  'client_fx_policy.read': 'Read Client FX Policy',
  'client_fx_policy.manage': 'Manage Client FX Policy',
  'client_configuration.read': 'Read Client Configuration',
  'client_configuration.manage': 'Manage Client Configuration',
  'building_configuration.read': 'Read Building Configuration',
  'building_configuration.manage': 'Manage Building Configuration',
  'vendor_invoice.read': 'Read Vendor Invoices',
  'vendor_invoice.manage': 'Manage Vendor Invoices',
};

/** Exceptional authorities withheld from PLATFORM_ADMIN — must stay exactly these. */
const EXPECTED_UNASSIGNED_BY_DEFAULT = [
  'operational_budget.override',
  'rfq.award',
  'price_catalog.override',
  'fx_rate.approve',
  // CR-BE-SAAS-01 PART 01 (frozen D2): the ENTIRE platform.* namespace is
  // withheld from default assignment — explicit grants only.
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
];

function walkRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walkRouteFiles(path));
    else if (name.endsWith('.routes.ts')) files.push(path);
  }
  return files;
}

const PERMISSION_CALL = /requirePermission\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

/** code → the route files that enforce it, across every mounted router. */
function enforcedCodesByFile(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of [...walkRouteFiles(MODULES_DIR), ...walkRouteFiles(ROUTES_DIR)]) {
    const label = relative(SRC_DIR, file);
    const source = readFileSync(file, 'utf8');
    PERMISSION_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PERMISSION_CALL.exec(source)) !== null) {
      const code = match[1];
      const seen = out.get(code);
      if (seen) seen.push(label);
      else out.set(code, [label]);
    }
  }
  return out;
}

function codesInFiles(files: readonly string[]): string[] {
  const found = new Set<string>();
  for (const rel of files) {
    const source = readFileSync(join(MODULES_DIR, rel), 'utf8');
    PERMISSION_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PERMISSION_CALL.exec(source)) !== null) found.add(match[1]);
  }
  return [...found].sort();
}

describe('CR-BE-CONFIG-PERM-01 — permission registry closure', () => {
  it('A. registers all 13 codes exactly once, with resource.action names', () => {
    assert.equal(REGISTERED_BY_THIS_CR.length, 13);

    for (const code of REGISTERED_BY_THIS_CR) {
      const occurrences = CATALOGUE.filter((entry) => entry === code).length;
      assert.equal(occurrences, 1, `${code} must appear exactly once`);

      const name = NAME_BY_CODE.get(code);
      assert.ok(name, `${code} must carry a display name`);
      assert.match(
        code,
        /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/,
        `${code} must follow the resource.action convention`,
      );
      // Labels describe only the existing runtime capability.
      assert.match(
        name as string,
        /^(Read|Manage) /,
        `${code} name must use the adjacent master-administration pattern`,
      );
    }

    // 320 pre-existing + 13 registered by this CR + 19 CR-BE-SAAS-01
    // platform.* codes (PART 01 seed).
    assert.equal(CATALOGUE.length, 352);
    assert.equal(CATALOGUE_SET.size, 352, 'catalogue must contain no duplicates');
  });

  for (const domain of Object.keys(DOMAIN_ROUTE_FILES)) {
    const expected = DOMAIN_EXPECTED_CODES[domain];

    it(`${domain.toUpperCase()}. every ${domain} route-enforced code resolves`, () => {
      const enforced = codesInFiles(DOMAIN_ROUTE_FILES[domain]);

      assert.ok(enforced.length > 0, `${domain} routers must enforce permissions`);
      for (const code of expected) {
        assert.ok(
          enforced.includes(code),
          `${domain} routers must still enforce ${code} (route authority unchanged)`,
        );
        assert.ok(
          CATALOGUE_SET.has(code),
          `${code} must exist in FOUNDATION_PERMISSIONS`,
        );
      }
      // No code enforced by these routers may be left unregistered.
      const unresolved = enforced.filter((code) => !CATALOGUE_SET.has(code));
      assert.deepEqual(unresolved, [], `${domain} has unregistered enforced codes`);
    });
  }

  it('WORKFORCE. does not invent workforce.read; manage side now resolves', () => {
    // workforce.read pre-existed (CR-BE-MOB-03 PART 01) and must not be
    // duplicated or renamed by this CR.
    const readOccurrences = CATALOGUE.filter((c) => c === 'workforce.read').length;
    assert.equal(readOccurrences, 1, 'workforce.read must appear exactly once');
    assert.equal(NAME_BY_CODE.get('workforce.read'), 'Read Workforce Profiles');
    assert.ok(
      !(REGISTERED_BY_THIS_CR as readonly string[]).includes('workforce.read'),
      'workforce.read must not be claimed as newly registered',
    );

    // Exactly two workforce.* codes exist: the pre-existing read and the newly
    // registered manage. Nothing else was minted in that namespace.
    const workforceCodes = CATALOGUE.filter((c) => c.startsWith('workforce.')).sort();
    assert.deepEqual(workforceCodes, ['workforce.manage', 'workforce.read']);

    // Read routes keep their existing authority: they use workforce.read, and
    // workforce.manage is required only where the routers already required it.
    const enforced = enforcedCodesByFile();
    assert.ok((enforced.get('workforce.read') ?? []).length >= 6);
    assert.ok((enforced.get('workforce.manage') ?? []).length >= 4);
    assert.ok(CATALOGUE_SET.has('workforce.manage'));
  });

  it('J. introduces no configuration.* umbrella permission', () => {
    const umbrella = CATALOGUE.filter((code) => code.startsWith('configuration.'));
    assert.deepEqual(umbrella, [], 'no configuration.* umbrella key may exist');

    for (const banned of [
      'configuration.view',
      'configuration.operations.view',
      'configuration.cms.view',
      'configuration.branding.view',
      'configuration.lifecycle.view',
      'configuration.branding.identity.view',
      'configuration.manage',
      'configuration.read',
    ]) {
      assert.equal(CATALOGUE_SET.has(banned), false, `${banned} must not exist`);
    }
  });

  it('K. introduces no wildcard or super-admin bypass', () => {
    for (const code of CATALOGUE) {
      assert.ok(!code.includes('*'), `${code} must not contain a wildcard`);
      assert.ok(!code.includes('%'), `${code} must not contain a wildcard`);
      assert.notEqual(code, '*', 'bare wildcard permission is forbidden');
      assert.notEqual(code, 'admin', 'bare admin permission is forbidden');
      assert.ok(
        !/^(super|root|all|any)(_|\.|$)/.test(code),
        `${code} must not be a super-user style code`,
      );
    }

    assert.equal(
      CATALOGUE_SET.has('*'),
      false,
      'catalogue must not contain a wildcard entry',
    );

    // The resolver must keep matching codes exactly — no prefix/wildcard logic.
    const rbac = readFileSync(RBAC_MIDDLEWARE_PATH, 'utf8');
    assert.ok(
      rbac.includes('permissions.includes(code)'),
      'RBAC must keep exact-match code resolution',
    );
    assert.ok(
      !/startsWith\(|endsWith\(|new RegExp\(|match\(/.test(rbac),
      'RBAC must not gain pattern-based permission matching',
    );
    assert.ok(
      rbac.includes('permissionDeniedError()'),
      'RBAC must keep default-deny behaviour',
    );
  });

  it('L. leaves unrelated codes and the default-assignment policy unchanged', () => {
    for (const [code, name] of Object.entries(UNRELATED_PINNED)) {
      assert.ok(CATALOGUE_SET.has(code), `${code} must remain registered`);
      assert.equal(NAME_BY_CODE.get(code), name, `${code} name must be unchanged`);
      const occurrences = CATALOGUE.filter((entry) => entry === code).length;
      assert.equal(occurrences, 1, `${code} must appear exactly once`);
    }

    // Exceptional-authority withholding is untouched: these 13 organizational
    // master-data codes are ordinary administration, so they follow the default
    // catalogue rule and are NOT withheld.
    const unassigned = [...UNASSIGNED_BY_DEFAULT_PERMISSION_CODES].sort();
    assert.deepEqual(unassigned, [...EXPECTED_UNASSIGNED_BY_DEFAULT].sort());

    for (const code of REGISTERED_BY_THIS_CR) {
      assert.equal(
        UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(code),
        false,
        `${code} must follow the default catalogue assignment policy`,
      );
    }
  });

  it('ROUTE-TO-REGISTRY. no mounted router enforces an unregistered code', () => {
    const enforced = enforcedCodesByFile();
    const unresolved = [...enforced.keys()]
      .filter((code) => !CATALOGUE_SET.has(code))
      .sort();

    assert.deepEqual(
      unresolved,
      [],
      `route-enforced codes missing from FOUNDATION_PERMISSIONS: ${unresolved.join(', ')}`,
    );

    // The seven affected domains specifically: expected missing count is 0.
    for (const domain of Object.keys(DOMAIN_ROUTE_FILES)) {
      for (const code of codesInFiles(DOMAIN_ROUTE_FILES[domain])) {
        assert.ok(
          CATALOGUE_SET.has(code),
          `${domain}: ${code} must exist in FOUNDATION_PERMISSIONS`,
        );
      }
    }
  });
});
