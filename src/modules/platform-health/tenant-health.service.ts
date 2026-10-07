/**
 * CR-BE-SAAS-01 PART 10A — Tenant health projection (frozen §21.1).
 *
 * The health projection is a DETERMINISTIC READ-MODEL composed from
 * canonical PART 05–09 sources. It does NOT mutate any of them and
 * it does NOT own subscription / billing / provisioning / quota /
 * entitlement state — it observes and reports.
 *
 * Persistence: §21.1 does NOT define a persisted snapshot. PART 10A
 * computes the projection on read; later PARTS may add a cache snapshot
 * if the contract introduces one.
 *
 * Audit: read-only projection; §18.2 has no health event; PART 10A
 * emits no `recordOperationalEvent` calls.
 *
 * Overall status precedence (frozen §21.1 clarification):
 *   SUSPENDED > ACTION_REQUIRED > DEGRADED > HEALTHY
 *   SUSPENDED is anchored on the canonical PART 03 §11.2 customer-
 *   status projection (`healthy wins`).
 *
 * Source ownership:
 *  - subscription             → `subscriptions` (canonical, 0013 + 0364)
 *                              multi-subscription rule reuses the
 *                              canonical PART 03 §11.2 rule 4 logic
 *                              (projectCustomerStatus): healthy wins.
 *  - billing                  → `saas_invoices` (canonical, 0367)
 *  - provisioning             → `saas_provisioning_runs` (canonical, 0368)
 *  - usage_quota              → PART 09 service (canonical, 0371)
 *  - integration_failures     → `integration_outbox_events`
 *                              (canonical, 0306) — customer-scoped via
 *                              `client_id`.
 *  - notification_failures    → `notification_email_deliveries` +
 *                              `notification_whatsapp_deliveries`
 *                              (canonical, 0241/0242) — customer-scoped
 *                              via `client_id`.
 *  - configuration_completeness → SOURCE_GAP (PART 12 territory; no
 *                              customer-scoped branding/config table
 *                              exists yet). sourceAvailable=false;
 *                              does NOT contribute to overall.
 *
 * Failure lookback window: read on read from the platform
 * configuration key `saas.health.failure_lookback_days` (frozen
 * §21.1 clarification). Default = 7 days when the key is absent.
 * The constant is never used to derive the lookback; it is only
 * the fallback default.
 */
import { getPool } from '../../database';
import { getCustomerUsageProjection } from '../platform-usage/saas-usage.service';
import { projectCustomerStatusFromStatuses } from '../platform-subscriptions/saas-customer-status.projector';
import {
  SAAS_HEALTH_FAILURE_LOOKBACK_DAYS_DEFAULT,
  SAAS_NEAR_RENEWAL_DAYS,
  SAAS_QUOTA_PRESSURE_RATIO,
  SAAS_REQUIRED_COMPONENTS,
  type SaasTenantHealth,
  type SaasTenantHealthComponent,
  type SaasTenantHealthComponentReport,
  type SaasTenantHealthEvidence,
  type SaasTenantHealthOverallStatus,
} from './tenant-health.types';

type SubscriptionRow = {
  id: string;
  status: string;
  renewal_date: Date | null;
};

type InvoiceRow = {
  status: string;
  due_at: Date | null;
};

type ProvisioningRow = {
  status: string;
};

type FailureCountRow = { n: string };

const COMPONENT_ORDER: readonly SaasTenantHealthComponent[] = [
  'subscription',
  'billing',
  'provisioning',
  'usage_quota',
  'configuration_completeness',
  'integration_failures',
  'notification_failures',
];

// ---------------------------------------------------------------------------
// Frozen §7.2 projection (canonical multi-subscription projector)
// ---------------------------------------------------------------------------

type Projection =
  | 'ACTIVE'
  | 'TRIAL'
  | 'GRACE'
  | 'SUSPENDED'
  | 'PROSPECT'
  | 'TERMINATED';

function projectCustomerStatusFromRows(
  rows: readonly SubscriptionRow[],
): Projection {
  // Delegates to the canonical PART 03 §7.2 projector
  // (saas-customer-status.projector) — single source of truth for the
  // frozen healthy-wins rule.
  return projectCustomerStatusFromStatuses(rows.map((r) => r.status)) as Projection;
}

// ---------------------------------------------------------------------------
// Configuration read (frozen §21.1 clarification)
// ---------------------------------------------------------------------------

async function readFailureLookbackDays(_now: Date): Promise<number> {
  try {
    // PART 12B: small swap — read through the canonical PART 12
    // configuration resolver. The seam still answers the same
    // §21.1 question (the lookback window) but no longer hand-rolls
    // the JSONB cast / fallback. Other readers (PART 08/10/11) are
    // intentionally NOT refactored here per the PART 12B brief.
    const { resolveConfiguration } = await import(
      '../platform-configurations'
    );
    const resolved = await resolveConfiguration(
      'saas.health.failure_lookback_days' as Parameters<
        typeof resolveConfiguration
      >[0],
    );
    const n =
      typeof resolved.value === 'number'
        ? resolved.value
        : typeof resolved.value === 'string'
          ? Number(resolved.value)
          : Number.NaN;
    if (!Number.isFinite(n) || n <= 0) {
      return SAAS_HEALTH_FAILURE_LOOKBACK_DAYS_DEFAULT;
    }
    return Math.floor(n);
  } catch {
    return SAAS_HEALTH_FAILURE_LOOKBACK_DAYS_DEFAULT;
  }
}

// ---------------------------------------------------------------------------
// Per-component evaluators
// ---------------------------------------------------------------------------

async function evaluateSubscription(
  customerId: string,
  now: Date,
): Promise<SaasTenantHealthComponentReport> {
  const result = await getPool().query<SubscriptionRow>(
    `SELECT id, status, renewal_date
       FROM subscriptions
      WHERE client_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [customerId],
  );
  const rows = result.rows;
  const projection = projectCustomerStatusFromRows(rows);
  const evidence: SaasTenantHealthEvidence[] = rows.map((r) => ({
    signal: 'subscription.status' as const,
    value: r.status,
  }));

  // Frozen §21.1 precedence rule: SUSPENDED only when the canonical
  // §11.2 customer-status projection is SUSPENDED.
  const actionRequired = projection === 'SUSPENDED';
  let degraded = projection === 'GRACE';

  if (projection === 'ACTIVE') {
    const activeRenewals = rows
      .filter((r) => r.status === 'ACTIVE' && r.renewal_date !== null)
      .map((r) => r.renewal_date!.getTime());
    if (activeRenewals.length > 0) {
      const soonest = Math.min(...activeRenewals);
      const daysToRenewal =
        (soonest - now.getTime()) / (24 * 60 * 60 * 1000);
      if (daysToRenewal >= 0 && daysToRenewal < SAAS_NEAR_RENEWAL_DAYS) {
        degraded = true;
        evidence.push({
          signal: 'subscription.near_renewal',
          value: Math.ceil(daysToRenewal),
        });
      }
    }
  }

  return {
    component: 'subscription',
    degraded,
    actionRequired,
    evidence,
    sourceAvailable: true,
  };
}

async function evaluateBilling(
  customerId: string,
  now: Date,
): Promise<SaasTenantHealthComponentReport> {
  const result = await getPool().query<InvoiceRow>(
    `SELECT status, due_at
       FROM saas_invoices
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [customerId],
  );
  const rows = result.rows;
  const evidence: SaasTenantHealthEvidence[] = [];
  let actionRequired = false;
  let degraded = false;
  const overdue = rows.filter((r) => r.status === 'OVERDUE');
  if (overdue.length > 0) {
    actionRequired = true;
    evidence.push({ signal: 'invoice.overdue', value: overdue.length });
  }
  const unpaidPastDue = rows.filter(
    (r) =>
      (r.status === 'ISSUED' || r.status === 'PARTIALLY_PAID') &&
      r.due_at !== null &&
      r.due_at.getTime() < now.getTime(),
  );
  if (unpaidPastDue.length > 0) {
    degraded = true;
    evidence.push({
      signal: 'invoice.unpaid_past_due',
      value: unpaidPastDue.length,
    });
  }
  return {
    component: 'billing',
    degraded,
    actionRequired,
    evidence,
    sourceAvailable: true,
  };
}

async function evaluateProvisioning(
  customerId: string,
): Promise<SaasTenantHealthComponentReport> {
  const result = await getPool().query<ProvisioningRow>(
    `SELECT status
       FROM saas_provisioning_runs
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [customerId],
  );
  const latest = result.rows[0];
  const evidence: SaasTenantHealthEvidence[] = [];
  if (!latest) {
    return {
      component: 'provisioning',
      degraded: false,
      actionRequired: false,
      evidence,
      sourceAvailable: true,
    };
  }
  if (latest.status === 'FAILED') {
    evidence.push({ signal: 'provisioning.latest_failed', value: 1 });
    return {
      component: 'provisioning',
      degraded: false,
      actionRequired: true,
      evidence,
      sourceAvailable: true,
    };
  }
  if (latest.status === 'RUNNING') {
    evidence.push({ signal: 'provisioning.latest_running', value: 1 });
    return {
      component: 'provisioning',
      degraded: true,
      actionRequired: false,
      evidence,
      sourceAvailable: true,
    };
  }
  return {
    component: 'provisioning',
    degraded: false,
    actionRequired: false,
    evidence,
    sourceAvailable: true,
  };
}

async function evaluateUsageQuota(
  customerId: string,
  now: Date,
): Promise<SaasTenantHealthComponentReport> {
  let projection: Awaited<ReturnType<typeof getCustomerUsageProjection>>;
  try {
    projection = await getCustomerUsageProjection(customerId, now);
  } catch {
    return {
      component: 'usage_quota',
      degraded: false,
      actionRequired: false,
      evidence: [],
      sourceAvailable: true,
    };
  }
  const evidence: SaasTenantHealthEvidence[] = [];
  let degraded = false;
  const pressured: string[] = [];
  for (const m of projection.meters) {
    if (typeof m.limit === 'number' && m.limit > 0) {
      const used = Number(m.used) || 0;
      const ratio = used / m.limit;
      if (ratio >= SAAS_QUOTA_PRESSURE_RATIO) {
        pressured.push(m.meterKey);
      }
    }
  }
  if (pressured.length > 0) {
    degraded = true;
    evidence.push({
      signal: 'usage.quota_pressure',
      value: pressured.join(','),
    });
  }
  return {
    component: 'usage_quota',
    degraded,
    actionRequired: false,
    evidence,
    sourceAvailable: true,
  };
}

async function evaluateIntegrationFailures(
  customerId: string,
  lookbackDays: number,
  now: Date,
): Promise<SaasTenantHealthComponentReport> {
  const since = new Date(
    now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  );
  const result = await getPool().query<FailureCountRow>(
    `SELECT COUNT(*)::text AS n
       FROM integration_outbox_events
      WHERE client_id = $1
        AND status = 'FAILED'
        AND created_at >= $2`,
    [customerId, since],
  );
  const failed = Number(result.rows[0]?.n ?? '0');
  if (failed > 0) {
    return {
      component: 'integration_failures',
      degraded: false,
      actionRequired: true,
      evidence: [{ signal: 'integration.failed_recent', value: failed }],
      sourceAvailable: true,
    };
  }
  return {
    component: 'integration_failures',
    degraded: false,
    actionRequired: false,
    evidence: [],
    sourceAvailable: true,
  };
}

async function evaluateNotificationFailures(
  customerId: string,
  lookbackDays: number,
  now: Date,
): Promise<SaasTenantHealthComponentReport> {
  const since = new Date(
    now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  );
  const pool = getPool();
  const [email, whatsApp] = await Promise.all([
    pool.query<FailureCountRow>(
      `SELECT COUNT(*)::text AS n
         FROM notification_email_deliveries
        WHERE client_id = $1
          AND status = 'FAILED'
          AND created_at >= $2`,
      [customerId, since],
    ),
    pool.query<FailureCountRow>(
      `SELECT COUNT(*)::text AS n
         FROM notification_whatsapp_deliveries
        WHERE client_id = $1
          AND status = 'FAILED'
          AND created_at >= $2`,
      [customerId, since],
    ),
  ]);
  const total =
    Number(email.rows[0]?.n ?? '0') +
    Number(whatsApp.rows[0]?.n ?? '0');
  if (total > 0) {
    return {
      component: 'notification_failures',
      degraded: false,
      actionRequired: true,
      evidence: [{ signal: 'notification.failed_recent', value: total }],
      sourceAvailable: true,
    };
  }
  return {
    component: 'notification_failures',
    degraded: false,
    actionRequired: false,
    evidence: [],
    sourceAvailable: true,
  };
}

// ---------------------------------------------------------------------------
// `configuration_completeness` evaluator (PART 12B — frozen §21.1
// contract clarification). Source seam:
//   `client_configurations.key = 'BRANDING.PROFILE'` for the target
//   customer. The component is NEVER read from `platform_configurations`
//   and NEVER from `saas.health.failure_lookback_days`.
//
// Required-key set (per the §21.1 clarification):
//   brandName (non-empty string after trim)
//   login     (object with at least one of title/showLogo set)
//   portal    (object with at least one of headerTitle/showLogo set)
//   report    (object with at least one of headerText/showLogo set)
//   theme     (object containing primaryColor)
//
// Explicitly OPTIONAL: logoReference, supportName, supportContact.
// Their absence or null value does NOT degrade the component.
// ---------------------------------------------------------------------------

type BrandingProfile = Record<string, unknown> & {
  brandName?: unknown;
  logoReference?: unknown;
  supportName?: unknown;
  supportContact?: unknown;
  login?: unknown;
  portal?: unknown;
  report?: unknown;
  theme?: unknown;
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function hasLoginPresence(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isNonEmptyString(o['title']) || o['showLogo'] === true;
}

function hasPortalPresence(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isNonEmptyString(o['headerTitle']) || o['showLogo'] === true;
}

function hasReportPresence(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isNonEmptyString(o['headerText']) || o['showLogo'] === true;
}

function hasThemePresence(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isNonEmptyString(o['primaryColor']);
}

interface CompletenessResult {
  degraded: boolean;
  evidence: import('./tenant-health.types').SaasTenantHealthEvidence[];
}

function checkProfile(profile: BrandingProfile): CompletenessResult {
  const missing: string[] = [];
  if (!isNonEmptyString(profile.brandName)) missing.push('brandName');
  if (!hasLoginPresence(profile.login)) missing.push('login');
  if (!hasPortalPresence(profile.portal)) missing.push('portal');
  if (!hasReportPresence(profile.report)) missing.push('report');
  if (!hasThemePresence(profile.theme)) missing.push('theme');
  if (missing.length === 0) {
    return {
      degraded: false,
      evidence: [],
    };
  }
  return {
    degraded: true,
    evidence: [
      {
        signal: 'configuration.required_keys_missing',
        value: missing.join(','),
      },
    ],
  };
}

async function evaluateConfigurationCompleteness(
  customerId: string,
): Promise<SaasTenantHealthComponentReport> {
  // PART 12B: source = `client_configurations(BRANDING.PROFILE)` for
  // the target customer. `sourceAvailable = true` — the source is
  // authoritative; a missing row is a real assessed failure.
  const result = await getPool().query<{ value: unknown }>(
    `SELECT value FROM client_configurations
      WHERE client_id = $1 AND key = 'BRANDING.PROFILE'
      ORDER BY created_at DESC LIMIT 1`,
    [customerId],
  );
  const row = result.rows[0];
  if (!row) {
    // §21.1 frozen: missing branding → `degraded = true`. PART 12C
    // severity alignment (frozen contract clarification): the
    // completeness dimension is NEVER `actionRequired`. It signals
    // a configuration gap (degraded, warning-class), not a
    // must-act-now operational failure. ACTION_REQUIRED is reserved
    // for canonical components like the subscription SUSPENDED
    // projection, billing OVERDUE, or provisioning FAILED.
    return {
      component: 'configuration_completeness',
      degraded: true,
      actionRequired: false,
      evidence: [
        {
          signal: 'configuration.branding_missing',
          value: true,
        },
      ],
      sourceAvailable: true,
    };
  }
  const profile = (row.value ?? {}) as BrandingProfile;
  if (typeof profile !== 'object' || profile === null) {
    return {
      component: 'configuration_completeness',
      degraded: true,
      actionRequired: false,
      evidence: [
        {
          signal: 'configuration.branding_missing',
          value: 'invalid_profile',
        },
      ],
      sourceAvailable: true,
    };
  }
  const check = checkProfile(profile);
  return {
    component: 'configuration_completeness',
    degraded: check.degraded,
    actionRequired: false,
    evidence: check.evidence,
    sourceAvailable: true,
  };
}

// ---------------------------------------------------------------------------
// Overall derivation — frozen precedence
// ---------------------------------------------------------------------------

/**
 * Frozen §21.1 contract clarification precedence:
 *
 *   SUSPENDED       — when subscription component reports
 *                     actionRequired=true (canonical §11.2 projection
 *                     is SUSPENDED).
 *   ACTION_REQUIRED — when any available component reports
 *                     actionRequired=true.
 *   DEGRADED        — when any available component reports
 *                     degraded=true.
 *   HEALTHY         — otherwise AND complete=true.
 *
 * Components with sourceAvailable=false do NOT contribute. The
 * `complete` flag is computed independently from the source-availability
 * of all REQUIRED components.
 */
function deriveOverall(
  components: readonly SaasTenantHealthComponentReport[],
): { overall: SaasTenantHealthOverallStatus; complete: boolean } {
  const sub = components.find((c) => c.component === 'subscription');
  if (sub && sub.sourceAvailable && sub.actionRequired) {
    return { overall: 'SUSPENDED', complete: computeComplete(components) };
  }
  let anyAction = false;
  let anyDegraded = false;
  for (const c of components) {
    if (!c.sourceAvailable) continue;
    if (c.actionRequired) anyAction = true;
    if (c.degraded) anyDegraded = true;
  }
  if (anyAction) {
    return {
      overall: 'ACTION_REQUIRED',
      complete: computeComplete(components),
    };
  }
  if (anyDegraded) {
    return { overall: 'DEGRADED', complete: computeComplete(components) };
  }
  return {
    overall: 'HEALTHY',
    complete: computeComplete(components),
  };
}

function computeComplete(
  components: readonly SaasTenantHealthComponentReport[],
): boolean {
  const byComponent = new Map(
    components.map((c) => [c.component, c.sourceAvailable]),
  );
  for (const required of SAAS_REQUIRED_COMPONENTS) {
    if (!byComponent.get(required)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

export async function getTenantHealth(
  customerId: string,
  now: Date = new Date(),
): Promise<SaasTenantHealth> {
  const lookbackDays = await readFailureLookbackDays(now);
  const components: SaasTenantHealthComponentReport[] = await Promise.all([
    evaluateSubscription(customerId, now),
    evaluateBilling(customerId, now),
    evaluateProvisioning(customerId),
    evaluateUsageQuota(customerId, now),
    evaluateConfigurationCompleteness(customerId),
    evaluateIntegrationFailures(customerId, lookbackDays, now),
    evaluateNotificationFailures(customerId, lookbackDays, now),
  ]);
  components.sort(
    (a, b) =>
      COMPONENT_ORDER.indexOf(a.component) -
      COMPONENT_ORDER.indexOf(b.component),
  );
  const { overall, complete } = deriveOverall(components);
  return {
    customerId,
    overallStatus: overall,
    components,
    complete,
    computedAt: now.toISOString(),
  };
}
