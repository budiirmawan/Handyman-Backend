/**
 * CR-HM-04 PART 02 — Handyman Worker Context types (FROZEN F2/F5/F8).
 *
 * A worker context establishes (participates-under relationship) the
 * Handyman provider's scope for one workforce profile. It duplicates NO
 * person identity: `workforce_profiles` (org-scope → client chain) is the
 * authoritative master and remains owner of login semantics
 * (`userId` may be NULL — helpers welcome, F5).
 */

export const HANDYMAN_WORKER_CONTEXT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HandymanWorkerContextStatus =
  (typeof HANDYMAN_WORKER_CONTEXT_STATUSES)[number];

export function isHandymanWorkerContextStatus(
  value: unknown,
): value is HandymanWorkerContextStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_WORKER_CONTEXT_STATUSES as readonly string[]).includes(value)
  );
}

export type HandymanWorkerContextRecord = {
  id: string;
  /** Tenant isolation root, verbatim from the provider context (vendor authority). */
  clientId: string;
  /** The PART 01 parent authority. */
  handymanProviderContextId: string;
  /** Authoritative person identity reference (never duplicated). */
  workforceProfileId: string;
  status: HandymanWorkerContextStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Caller input — clientId/actor are NEVER input. */
export type CreateHandymanWorkerContextInput = {
  handymanProviderContextId: string;
  workforceProfileId: string;
};

export type NewHandymanWorkerContextRecord = Omit<
  HandymanWorkerContextRecord,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;

/** Safe public representation (timestamps ISO). */
export type PublicHandymanWorkerContext = Omit<
  HandymanWorkerContextRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};
