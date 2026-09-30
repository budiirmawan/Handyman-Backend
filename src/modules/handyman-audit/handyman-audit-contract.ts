/**
 * CR-HM-16 PART 03 — Handyman audit + integration-reliability contract
 * (governance `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §3.3/§3.4/§3.5,
 * §7 seams 3–5, §9 PART 03 row: "Handyman audit context/vocabulary over
 * `recordOperationalEvent`/`audit` seam; outbox/webhook subscription
 * contracts; idempotency/claim-before-send law for this CR's future
 * mutations").
 *
 * WHAT THIS OWNS
 * --------------
 * The frozen Handyman EVENT VOCABULARY as audit facts, the audit CONTEXT law
 * (correlation, append-only, entity firewall), the integration SUBSCRIPTION
 * contract over the existing outbox/webhook family, and the reliability law
 * every future CR-HM-16 mutation inherits.
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No audit store, no event log, no outbox, no scheduler, no webhook stack, no
 * idempotency service. `operational_events` + `recordOperationalEvent` stay
 * the single business-event/audit authority (CR-BE-AUDIT-01); the
 * `integration_outbox_events` / `integration_webhook_*` family stays the
 * single fan-out capability (CR-BE-INTEG-01); `request-idempotency` and the
 * `due-job-dispatcher` stay the single reliability substrate (CR-BE-STAB-01).
 * This contract only states WHICH Handyman events exist, HOW they are
 * correlated, and WHICH laws their recording and delivery inherit — never a
 * second write path for any domain fact, never a mutable audit trail, never a
 * replay/backfill mechanism.
 *
 * FM/SaaS FIREWALL (frozen)
 * -------------------------
 * Handyman events carry Handyman entity identities only (the `HANDYMAN_`
 * namespace: Handyman SLA subjects and Handyman domain objects). No FM Work
 * Order / work-order-sla-register identity and no SaaS
 * subscription/entitlement/billing identity may ever appear as a Handyman
 * event subject.
 */

/** Fact class of an admitted Handyman audit event. */
export type HandymanAuditFactKind = 'DOMAIN' | 'SLA';

/** One frozen audit-vocabulary entry. */
export type HandymanAuditEventEntry = {
  eventType: string;
  factKind: HandymanAuditFactKind;
  meaning: string;
};

/**
 * Frozen Handyman audit vocabulary: the events this CR binds to the audit and
 * integration seams. The SLA chain entries are the shared engine's emissions
 * as they land on Handyman subjects; the domain entries are the certified
 * CR-HM-01..15 lifecycle vocabularies (the same admitted set as the PART 02
 * notification contract — meaning per event is owned there; fact kind is
 * owned here).
 */
export const HANDYMAN_AUDIT_EVENT_CONTRACT: readonly HandymanAuditEventEntry[] = [
  // ---- SLA chain (shared engine facts on Handyman subjects) --------------
  {
    eventType: 'SLA_CLOCK_BREACHED',
    factKind: 'SLA',
    meaning: 'A Handyman SLA milestone clock recorded its first-write breach fact.',
  },
  {
    eventType: 'SLA_ESCALATION_SCHEDULED',
    factKind: 'SLA',
    meaning: 'A Handyman breach materialized its frozen escalation intentions.',
  },
  {
    eventType: 'SLA_ESCALATION_TRIGGERED',
    factKind: 'SLA',
    meaning: 'A Handyman escalation level was claimed and produced notification intent.',
  },
  {
    eventType: 'SLA_ESCALATION_CANCELLED',
    factKind: 'SLA',
    meaning: 'A still-pending Handyman escalation intention was retired with the clock.',
  },
  {
    eventType: 'SLA_ESCALATION_POLICY_AMBIGUOUS',
    factKind: 'SLA',
    meaning: 'Escalation policy selection for a Handyman breach was ambiguous; nothing was scheduled.',
  },
  // ---- Handyman domain events (certified CR-HM-01..15 vocabularies) ------
  {
    eventType: 'HANDYMAN_REQUEST_TRIAGED',
    factKind: 'DOMAIN',
    meaning: 'A service request received its triage outcome.',
  },
  {
    eventType: 'HANDYMAN_REFERRAL_CREATED',
    factKind: 'DOMAIN',
    meaning: 'A specialist referral was created for a service request.',
  },
  {
    eventType: 'HANDYMAN_QUOTATION_ISSUED',
    factKind: 'DOMAIN',
    meaning: 'A quotation was issued and awaits the customer decision window.',
  },
  {
    eventType: 'HANDYMAN_QUOTATION_SUPERSEDED',
    factKind: 'DOMAIN',
    meaning: 'A quotation was superseded by a newer revision.',
  },
  {
    eventType: 'HANDYMAN_QUOTATION_EXPIRED',
    factKind: 'DOMAIN',
    meaning: 'A quotation expired without an approved decision.',
  },
  {
    eventType: 'HANDYMAN_PERMIT_READINESS_CREATED',
    factKind: 'DOMAIN',
    meaning: 'A permit readiness obligation was opened for an execution scope.',
  },
  {
    eventType: 'HANDYMAN_SCHEDULING_READINESS_CREATED',
    factKind: 'DOMAIN',
    meaning: 'A scheduling readiness obligation was opened for an execution scope.',
  },
  {
    eventType: 'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
    factKind: 'DOMAIN',
    meaning: 'A unit access readiness obligation was opened for an execution scope.',
  },
  {
    eventType: 'HANDYMAN_CREW_LEAD_DESIGNATED',
    factKind: 'DOMAIN',
    meaning: 'A crew lead was designated for an execution scope.',
  },
  {
    eventType: 'HANDYMAN_CREW_MEMBER_ADDED',
    factKind: 'DOMAIN',
    meaning: 'A crew member was added to an execution scope.',
  },
];

export function isHandymanAuditEventType(eventType: string): boolean {
  return HANDYMAN_AUDIT_EVENT_CONTRACT.some((entry) => entry.eventType === eventType);
}

export function handymanAuditContractFor(
  eventType: string,
): HandymanAuditEventEntry | undefined {
  return HANDYMAN_AUDIT_EVENT_CONTRACT.find((entry) => entry.eventType === eventType);
}

/**
 * Handyman entity namespace. Every Handyman event subject (SLA subject or
 * domain object) lives under this prefix — the frozen FM/SaaS firewall at the
 * audit boundary.
 */
export const HANDYMAN_ENTITY_NAMESPACE = /^HANDYMAN_[A-Z0-9_]+$/;

export function isHandymanEntityType(entityType: string): boolean {
  return HANDYMAN_ENTITY_NAMESPACE.test(entityType);
}

/**
 * The audit context law (§3.3): correlation, append-only, scrubbing. Stated
 * as frozen facts; the enforcement is the reused `recordOperationalEvent`
 * seam itself (this CR restates nothing).
 */
export const HANDYMAN_AUDIT_CONTEXT_LAW = Object.freeze({
  /** The single business-event/audit authority. No second event log exists. */
  authority: 'operational_events.recordOperationalEvent',
  /** Append-only at the application boundary: no UPDATE, no DELETE, no rewrite. */
  appendOnly: true,
  /** Credential/token metadata keys are scrubbed before persistence. */
  sensitiveKeyScrubbing: true,
  correlation: Object.freeze({
    /** `HTTP` reads the authoritative request context; it can never be overridden. */
    sources: Object.freeze(['HTTP', 'SCHEDULER', 'SYSTEM']),
    httpRequestContextAuthoritative: true,
    /** Trusted non-HTTP execution may pass an explicit SCHEDULER/System correlation. */
    overrideSources: Object.freeze(['SCHEDULER', 'SYSTEM']),
    requestId: 'server-generated UUID',
  }),
  /** Handyman events carry Handyman entity identities only (FM/SaaS firewall). */
  entityNamespace: 'HANDYMAN_',
});

/**
 * The integration subscription contract (§3.4): Handyman integration events
 * are separately scoped subscriptions over the EXISTING outbox/webhook family.
 * Reliability semantics (claim-before-send, bounded retry, HMAC signature) are
 * inherited, not restated as new infrastructure.
 */
export const HANDYMAN_INTEGRATION_SUBSCRIPTION_CONTRACT = Object.freeze({
  /** Endpoint registry: per-client endpoints subscribe by event type. */
  registry: 'integration_webhook_endpoints.event_types',
  /** Fan-out is prospective only: outbox rows exist only for events recorded while a matching ACTIVE endpoint exists. */
  prospectiveOnly: true,
  /** No historical replay/backfill is ever performed. */
  replayOrBackfill: false,
  /** One outbox marker per operational event row (unique reference). */
  oneMarkerPerEvent: true,
  /** Delivery is the inherited claim-before-send ledger with bounded retry and signature. */
  delivery: 'inherited:claim-before-send+bounded-retry+signature',
  /** Integration audit events never re-enter the outbox (recursion blocklist). */
  recursionBlocklist: Object.freeze(['INTEGRATION_*', 'NOTIFICATION_OUTBOUND_*']),
});

/**
 * The reliability law (§3.5) every future CR-HM-16 mutation inherits: the
 * shared request-idempotency identity, the claim-before-send pattern, the
 * single due-job dispatcher, and the transactional outbox. Nothing here is a
 * new substrate — the law names the seams that already exist.
 */
export const HANDYMAN_RELIABILITY_LAW = Object.freeze({
  idempotencyIdentity: 'actorUserId + operationKey + SHA-256(idempotencyKey)',
  requestFingerprint: 'SHA-256(stable canonical JSON)',
  conflict: '409 IDEMPOTENCY_CONFLICT',
  claimBeforeSend: 'FOR UPDATE SKIP LOCKED + guarded PENDING->CLAIMED UPDATE',
  dispatcher: 'due-job-dispatcher.processDueOperationalJobs',
  scheduler: 'due-job-scheduler (singleton setInterval)',
  transactionalOutbox: 'same-executor enqueue inside recordOperationalEvent',
});

/**
 * Operation-key namespace for this CR's future mutations: Handyman idempotent
 * operations are admitted under `hm.*` only, so a Handyman mutation can never
 * collide with (nor impersonate) another surface's idempotency scope.
 */
export const HANDYMAN_OPERATION_KEY_PATTERN = /^hm\.[a-z0-9][a-z0-9_.-]{0,62}$/;
