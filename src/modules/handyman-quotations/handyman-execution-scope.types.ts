/**
 * CR-HM-06 PART 05 — Handyman Execution Scope types (FROZEN F8/F9/F10/F11/
 * F12). The single authoritative operational target created ONLY inside a
 * successful quotation APPROVE transaction. Every authority field is a
 * server-derived snapshot of the approved quotation → request → immutable
 * attribution/location lineage chain; NO caller input exists for this entity.
 * Execution Scope != FM work order (F12). Downstream bindings (CR-HM-04/05/
 * 07/08) consume this identity later — nothing here implements them.
 *
 * W03 PART 03E (A01 §7.1 + §10.3 C6/C7, migrations `0439`/`0442`): the scope
 * row records WHO CREATED it in the same discriminated shape the decision
 * ledger uses, because a PIC approval must not fabricate a staff user in order
 * to satisfy a NOT NULL column. `createdByUserId` becomes nullable for exactly
 * that reason, and the widening is safe rather than merely tolerated: A01 §7.2
 * E4 was re-verified for this PART — no consumer joins
 * `handyman_execution_scopes.created_by_user_id` to `users` (only this module
 * reads the column at all), so a NULL cannot silently drop a downstream row.
 * Any future join must be LEFT and actor-class aware.
 */

/** Bounded lifecycle: exactly one state exists in CR-HM-06. */
export const HANDYMAN_EXECUTION_SCOPE_STATUSES = ['AUTHORIZED'] as const;
export type HandymanExecutionScopeStatus =
  (typeof HANDYMAN_EXECUTION_SCOPE_STATUSES)[number];

/** Stored actor classes (`0439` CHECK vocabulary, A01 §7.1). */
export const HANDYMAN_EXECUTION_SCOPE_ACTOR_TYPES = [
  'USER',
  'TENANT_PIC',
] as const;
export type HandymanExecutionScopeActorType =
  (typeof HANDYMAN_EXECUTION_SCOPE_ACTOR_TYPES)[number];

/**
 * The creating actor of a scope row. There is no `SYSTEM` arm here on purpose:
 * E1 says a scope may only be created by the APPROVE branch of a decision, and
 * an unattributed insert would be exactly the bypass that rule forbids.
 */
export type HandymanExecutionScopeActor =
  | { kind: 'USER'; userId: string }
  | {
      kind: 'TENANT_PIC';
      /** Must equal the APPROVE decision's `decidedByTenantPicId` (E2). */
      tenantPicId: string;
      /** The credential that carried the approval that produced this row. */
      picSessionId: string;
    };

/** Full execution scope database record (immutable authority). */
export type HandymanExecutionScopeRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  channelAttributionId: string;
  quotationId: string;
  /** UNIQUE: exactly one scope per approved quotation version (F9). */
  approvedQuotationVersionId: string;
  /** Provenance: the exact immutable APPROVE decision (F8). */
  quotationDecisionId: string;
  tenantCompanyId: string;
  /** NULL when the authoritative lineage has no PIC (never fabricated). */
  tenantPicId: string | null;
  /** Authoritative location snapshot (server-derived; CR-HM-07 target). */
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  status: HandymanExecutionScopeStatus;
  createdByUserId: string | null;
  createdByActorType: HandymanExecutionScopeActorType;
  createdByTenantPicId: string | null;
  createdByPicSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation. The actor class is projected with the ids, so a
 * consumer can tell "no user by design" apart from "unknown user" without
 * guessing from a NULL.
 *
 * C7 widens this projection by exactly two fields (`createdByActorType`,
 * `createdByTenantPicId`) and `createdByUserId` becomes nullable.
 * `createdByPicSessionId` is omitted, and the omission is in the TYPE rather
 * than only in the mapper, so no consumer can start reading a credential id out
 * of an operational projection by accident — the ledger records it, the scope's
 * public shape cannot express it.
 */
export type PublicHandymanExecutionScope = Omit<
  HandymanExecutionScopeRecord,
  'createdAt' | 'updatedAt' | 'createdByPicSessionId'
> & { createdAt: string; updatedAt: string };

/**
 * Fully-resolved row ready for persistence (server-derived only). The actor
 * half is the discriminated union rather than a bare user id, so the column
 * shape and the actor class are made to agree in exactly one place.
 */
export type NewHandymanExecutionScope = Omit<
  HandymanExecutionScopeRecord,
  | 'id'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'createdByUserId'
  | 'createdByActorType'
  | 'createdByTenantPicId'
  | 'createdByPicSessionId'
> & { actor: HandymanExecutionScopeActor };
