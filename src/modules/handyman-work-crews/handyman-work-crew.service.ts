import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
  type ClientRecord,
} from '../clients';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { workforceNotExternalError } from '../external-workforce';
import {
  handymanProviderNotFoundError,
  handymanProviderRepository,
  handymanProviderStatusInvalidError,
} from '../handyman-providers';
import { recordOperationalEvent } from '../operational-events';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import {
  vendorWorkforceBindingNotFoundError,
  vendorWorkforceClientMismatchError,
} from '../vendor-workforce';
import { workforceProfileInactiveError } from '../workforce';
import {
  handymanWorkCrewCodeAlreadyExistsError,
  handymanWorkCrewLeadAlreadyActiveError,
  handymanWorkCrewLeadRemovalForbiddenError,
  handymanWorkCrewLeadRequiredError,
  handymanWorkCrewMemberAlreadyActiveError,
  handymanWorkCrewMemberNotFoundError,
  handymanWorkCrewMemberStatusInvalidError,
  handymanWorkCrewNotFoundError,
  handymanWorkCrewProviderClientMismatchError,
  handymanWorkCrewStatusInvalidError,
  handymanWorkCrewWorkerBindingInactiveError,
  handymanWorkCrewWorkerProviderMismatchError,
} from './handyman-work-crew.errors';
import { handymanWorkCrewRepository } from './handyman-work-crew.repository';
import type {
  AddHandymanWorkCrewMemberInput,
  ChangeHandymanWorkCrewLeadInput,
  CreateHandymanWorkCrewInput,
  CrewWorkerCandidate,
  HandymanWorkCrewFilters,
  HandymanWorkCrewMemberFilters,
  HandymanWorkCrewMemberRecord,
  HandymanWorkCrewRecord,
  PublicHandymanWorkCrew,
  PublicHandymanWorkCrewMember,
  UpdateHandymanWorkCrewInput,
  UpdateHandymanWorkCrewStatusInput,
} from './handyman-work-crew.types';
import type { PoolClient } from 'pg';

/**
 * CR-HM-BE-04 RUN 1 — Handyman Work Crew governance authority.
 *
 * Composes existing foundations; duplicates none of their rules:
 * - Provider organization authority: the CR-HM-BE-02 `handyman_providers`
 *   designation (never a second provider master). Provider↔Building stays on
 *   BE-06D and Provider↔Service stays on BE-06E — this service creates no
 *   building/service eligibility data and no per-worker building eligibility.
 * - Worker/person authority: `vendor_workforce_bindings` (BE-06F) joined to
 *   `workforce_profiles` (BE-03C, EXTERNAL via 0031) and resolved to a
 *   Client through `organizations` — CONSUMED read-only. This service never
 *   creates a user, credential, role, permission, building access, workforce
 *   profile, external workforce link, or vendor workforce binding. A HELPER
 *   (and structurally a LEAD_WORKER too, in BE-04) never requires a User
 *   account; a future authenticated mobile Lead Worker uses the existing
 *   nullable unique `workforce_profiles.user_id` link.
 * - Actor data scope: BE-02G `contextAccessService.canAccessClient` (the
 *   BE-27A client-scope idiom — permission checks stay in RBAC middleware).
 *
 * Lifecycle design (the smallest safe design consistent with repo patterns):
 * - A crew is created ACTIVE together with its founding LEAD_WORKER
 *   membership in ONE transaction, so the invariant "an operational ACTIVE
 *   crew has exactly one ACTIVE lead" holds unconditionally — there is no
 *   preparation state and no zero-lead window anywhere in the lifecycle.
 * - The partial unique index guarantees AT MOST one ACTIVE lead; the AT
 *   LEAST one side is enforced here: `addMember(LEAD_WORKER)` is rejected
 *   while a lead exists, direct lead removal is forbidden, the lead can only
 *   end through the atomic `changeLeadWorker` replacement, and reactivation
 *   re-asserts a valid active lead (the BE-02 reactivation idiom).
 * - An INACTIVE crew is frozen: membership commands require an ACTIVE crew
 *   (no preparation-before-activation convention exists in this repo). A
 *   crew whose lead binding later fails validation cannot be reactivated —
 *   it retires and a new crew is created; history is never rewritten.
 * - INACTIVE memberships are immutable evidence: the only write to a member
 *   row is the guarded ACTIVE→INACTIVE closure with removal attribution;
 *   nothing deletes rows and nothing mutates a historical row's identity or
 *   role.
 *
 * Concurrency: every membership mutation locks the crew row (`lockById ...
 * FOR UPDATE`) inside `withTransaction`, serializing adds/removals/lead
 * changes per crew; the partial unique indexes remain the structural
 * authority and their violations are translated into domain 409s; crew and
 * member lifecycle transitions are guarded (`... WHERE status = expected`)
 * so a stale transition cannot overwrite newer state. No distributed
 * locking infrastructure is introduced.
 *
 * Audit: meaningful lifecycle changes are recorded through the existing
 * BE-07 `recordOperationalEvent` convention with IDs/status/role only —
 * never worker full names, personnel codes, or contact data.
 */

const UNIQUE_VIOLATION = '23505';
const CREW_CODE_ACTIVE_UNIQUE = 'handyman_work_crews_one_active_code_per_provider';
const MEMBER_ACTIVE_UNIQUE =
  'handyman_work_crew_members_one_active_per_crew_binding';
const LEAD_ACTIVE_UNIQUE =
  'handyman_work_crew_members_one_active_lead_per_crew';

const MAX_CREW_CODE_LENGTH = 100;
const MAX_CREW_NAME_LENGTH = 200;
const CREW_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]*$/;

type Executor = Pick<PoolClient, 'query'>;

export function normalizeCrewCode(code: string): string {
  return code.trim().toUpperCase();
}

function assertCrewCode(crewCode: string): string {
  if (
    crewCode.length < 1 ||
    crewCode.length > MAX_CREW_CODE_LENGTH ||
    !CREW_CODE_PATTERN.test(crewCode)
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'crewCode',
        message: `crewCode must be 1-${MAX_CREW_CODE_LENGTH} characters and may contain letters, digits, dot, underscore, and hyphen, starting with a letter or digit.`,
      },
    ]);
  }
  return crewCode;
}

function assertCrewName(crewName: string): string {
  if (crewName.length < 1 || crewName.length > MAX_CREW_NAME_LENGTH) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'crewName',
        message: `crewName must be 1-${MAX_CREW_NAME_LENGTH} characters.`,
      },
    ]);
  }
  return crewName;
}

export function toPublicHandymanWorkCrew(
  record: HandymanWorkCrewRecord,
): PublicHandymanWorkCrew {
  return {
    id: record.id,
    clientId: record.clientId,
    handymanProviderId: record.handymanProviderId,
    crewCode: record.crewCode,
    crewName: record.crewName,
    status: record.status,
    createdByUserId: record.createdByUserId,
    updatedByUserId: record.updatedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicHandymanWorkCrewMember(
  record: HandymanWorkCrewMemberRecord,
): PublicHandymanWorkCrewMember {
  return {
    id: record.id,
    clientId: record.clientId,
    crewId: record.crewId,
    vendorWorkforceBindingId: record.vendorWorkforceBindingId,
    crewRole: record.crewRole,
    status: record.status,
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveTo: record.effectiveTo ? record.effectiveTo.toISOString() : null,
    addedAt: record.addedAt.toISOString(),
    addedByUserId: record.addedByUserId,
    removedAt: record.removedAt ? record.removedAt.toISOString() : null,
    removedByUserId: record.removedByUserId,
  };
}

async function assertClientAccess(
  userId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function requireClient(clientId: string): Promise<ClientRecord> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  return client;
}

/**
 * Asserts the crew's provider chain is operational: the CR-HM-BE-02
 * designation exists, belongs to the Client, and is ACTIVE, and its Vendor
 * (BE-06A) is ACTIVE. Entitlement is deliberately NOT re-resolved here —
 * the commercial right belongs to the designation lifecycle (BE-02 asserts
 * it at designation and reactivation); a crew consumes the designation.
 * Returns the provider's vendor id for worker validation.
 */
async function requireOperationalProviderVendor(
  clientId: string,
  handymanProviderId: string,
): Promise<string> {
  const provider = await handymanProviderRepository.findById(handymanProviderId);
  if (!provider) {
    throw handymanProviderNotFoundError();
  }
  if (provider.clientId !== clientId) {
    throw handymanWorkCrewProviderClientMismatchError();
  }
  if (provider.status !== 'ACTIVE') {
    throw handymanProviderStatusInvalidError(
      'The handyman provider designation is not active.',
    );
  }
  const vendor = await vendorRepository.findById(provider.vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  return provider.vendorId;
}

/**
 * Worker validation through the EXISTING personnel authority only (§3):
 * binding ACTIVE → binding belongs to the crew's provider Vendor → profile
 * ACTIVE → profile EXTERNAL → profile resolves to the crew's Client
 * (profile → organization → client, the BE-06F chain). The binding row is
 * locked for the caller's transaction. Rules owned by other authorities are
 * reported with THEIR errors (BE-06F/BE-03C/BE-03H reuse).
 */
async function requireValidCrewWorker(
  vendorWorkforceBindingId: string,
  crewClientId: string,
  providerVendorId: string,
  executor: Executor,
): Promise<CrewWorkerCandidate> {
  const candidate = await handymanWorkCrewRepository.lockWorkerCandidate(
    vendorWorkforceBindingId,
    executor,
  );
  if (!candidate) {
    throw vendorWorkforceBindingNotFoundError();
  }
  if (candidate.bindingStatus !== 'ACTIVE') {
    throw handymanWorkCrewWorkerBindingInactiveError();
  }
  if (candidate.vendorId !== providerVendorId) {
    throw handymanWorkCrewWorkerProviderMismatchError();
  }
  if (candidate.profileStatus !== 'ACTIVE') {
    throw workforceProfileInactiveError();
  }
  if (candidate.workforceType !== 'EXTERNAL') {
    throw workforceNotExternalError();
  }
  if (candidate.profileClientId !== crewClientId) {
    throw vendorWorkforceClientMismatchError();
  }
  return candidate;
}

function uniqueViolationConstraint(error: unknown): string | null {
  if (
    !(error instanceof Error) ||
    (error as { code?: string }).code !== UNIQUE_VIOLATION
  ) {
    return null;
  }
  return (error as { constraint?: string }).constraint ?? null;
}

/**
 * Creates an ACTIVE crew for an ACTIVE Handyman provider designation,
 * atomically seating the founding LEAD_WORKER. `createdByUserId` always
 * comes from the authenticated actor — the input shape cannot carry an
 * actor identity.
 */
export async function createHandymanWorkCrew(
  input: CreateHandymanWorkCrewInput,
  actorUserId: string,
): Promise<{
  crew: PublicHandymanWorkCrew;
  leadMember: PublicHandymanWorkCrewMember;
}> {
  // 1. Client existence, actor data scope, Client status (BE-27A order).
  const client = await requireClient(input.clientId);
  await assertClientAccess(actorUserId, client.id);
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  // 2. Provider designation authority (CR-HM-BE-02).
  const providerVendorId = await requireOperationalProviderVendor(
    client.id,
    input.handymanProviderId,
  );

  // 3. Crew metadata normalization/validation (identity is immutable after
  //    creation; crew_code is unique per provider among ACTIVE crews).
  const crewCode = assertCrewCode(normalizeCrewCode(input.crewCode));
  const crewName = assertCrewName(input.crewName.trim());

  const existing = await handymanWorkCrewRepository.findActiveByProviderAndCode(
    input.handymanProviderId,
    crewCode,
  );
  if (existing) {
    throw handymanWorkCrewCodeAlreadyExistsError();
  }

  try {
    return await withTransaction(async (tx) => {
      // 4. Founding Lead Worker validated through the existing personnel
      //    authority BEFORE the crew row exists — an invalid lead creates
      //    no crew at all.
      await requireValidCrewWorker(
        input.leadWorkerBindingId,
        client.id,
        providerVendorId,
        tx,
      );

      const crew = await handymanWorkCrewRepository.create(
        {
          clientId: client.id,
          handymanProviderId: input.handymanProviderId,
          crewCode,
          crewName,
          status: 'ACTIVE',
          createdByUserId: actorUserId,
          updatedByUserId: actorUserId,
        },
        tx,
      );

      const leadMember = await handymanWorkCrewRepository.createMember(
        {
          clientId: crew.clientId,
          crewId: crew.id,
          vendorWorkforceBindingId: input.leadWorkerBindingId,
          crewRole: 'LEAD_WORKER',
          status: 'ACTIVE',
          addedByUserId: actorUserId,
        },
        tx,
      );

      // IDs/status only — never worker names, personnel codes, or contacts.
      await recordOperationalEvent(
        {
          clientId: crew.clientId,
          eventType: 'HANDYMAN_WORK_CREW_CREATED',
          entityType: 'HANDYMAN_WORK_CREW',
          entityId: crew.id,
          actorUserId,
          summary: `Handyman work crew ${crew.crewCode} created.`,
          metadata: {
            handymanProviderId: crew.handymanProviderId,
            status: crew.status,
            leadMemberId: leadMember.id,
            crewRole: leadMember.crewRole,
          },
        },
        tx,
      );

      return {
        crew: toPublicHandymanWorkCrew(crew),
        leadMember: toPublicHandymanWorkCrewMember(leadMember),
      };
    });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === CREW_CODE_ACTIVE_UNIQUE) {
      throw handymanWorkCrewCodeAlreadyExistsError();
    }
    if (constraint === MEMBER_ACTIVE_UNIQUE) {
      throw handymanWorkCrewMemberAlreadyActiveError();
    }
    throw error;
  }
}

export async function getHandymanWorkCrewById(
  id: string,
  actorUserId: string,
): Promise<PublicHandymanWorkCrew> {
  const record = await handymanWorkCrewRepository.findById(id);
  if (!record) {
    throw handymanWorkCrewNotFoundError();
  }
  await assertClientAccess(actorUserId, record.clientId);
  return toPublicHandymanWorkCrew(record);
}

/**
 * Lists a Client's crews including INACTIVE history rows — the preserved
 * crew history is a first-class read surface (the BE-02 list idiom).
 */
export async function listHandymanWorkCrews(
  clientId: string,
  actorUserId: string,
  filters: HandymanWorkCrewFilters = {},
): Promise<PublicHandymanWorkCrew[]> {
  await requireClient(clientId);
  await assertClientAccess(actorUserId, clientId);
  const records = await handymanWorkCrewRepository.listByClient(
    clientId,
    filters,
  );
  return records.map(toPublicHandymanWorkCrew);
}

/**
 * Renames a crew. `crewCode`, `clientId`, and `handymanProviderId` are
 * immutable identity facts — no update surface exists for them. Renaming is
 * metadata-only and is allowed in either crew status (it has no operational
 * membership effect).
 */
export async function updateHandymanWorkCrew(
  id: string,
  input: UpdateHandymanWorkCrewInput,
  actorUserId: string,
): Promise<PublicHandymanWorkCrew> {
  const record = await handymanWorkCrewRepository.findById(id);
  if (!record) {
    throw handymanWorkCrewNotFoundError();
  }
  await assertClientAccess(actorUserId, record.clientId);

  const crewName = assertCrewName(input.crewName.trim());

  const updated = await handymanWorkCrewRepository.updateMetadata(
    id,
    crewName,
    actorUserId,
  );
  if (!updated) {
    throw handymanWorkCrewNotFoundError();
  }

  await recordOperationalEvent({
    clientId: updated.clientId,
    eventType: 'HANDYMAN_WORK_CREW_UPDATED',
    entityType: 'HANDYMAN_WORK_CREW',
    entityId: updated.id,
    actorUserId,
    summary: `Handyman work crew ${updated.crewCode} metadata updated.`,
    metadata: { status: updated.status },
  });

  return toPublicHandymanWorkCrew(updated);
}

/**
 * ACTIVE ↔ INACTIVE lifecycle on the crew row.
 *
 * Deactivation always succeeds from ACTIVE (fail-safe direction — the crew
 * freezes with its memberships untouched; they are not operational while
 * the crew is INACTIVE). Reactivation re-asserts the full crew invariants
 * (the BE-02 reactivation idiom): ACTIVE Client, ACTIVE provider
 * designation with ACTIVE Vendor, and a valid ACTIVE lead whose binding
 * chain still passes worker validation — an ACTIVE operational crew must
 * never be left with zero ACTIVE leads. The transition itself is guarded
 * (`updateStatusFrom`) inside a crew-row lock so concurrent lifecycle
 * commands cannot both succeed.
 */
export async function updateHandymanWorkCrewStatus(
  id: string,
  input: UpdateHandymanWorkCrewStatusInput,
  actorUserId: string,
): Promise<PublicHandymanWorkCrew> {
  const record = await handymanWorkCrewRepository.findById(id);
  if (!record) {
    throw handymanWorkCrewNotFoundError();
  }
  await assertClientAccess(actorUserId, record.clientId);

  if (record.status === input.status) {
    throw handymanWorkCrewStatusInvalidError(
      input.status === 'INACTIVE'
        ? 'The handyman work crew is already inactive.'
        : 'The handyman work crew is already active.',
    );
  }

  if (input.status === 'ACTIVE') {
    const client = await requireClient(record.clientId);
    if (client.status !== 'ACTIVE') {
      throw clientInactiveError();
    }

    const updated = await withTransaction(async (tx) => {
      const locked = await handymanWorkCrewRepository.lockById(id, tx);
      if (!locked) {
        throw handymanWorkCrewNotFoundError();
      }
      if (locked.status !== 'INACTIVE') {
        throw handymanWorkCrewStatusInvalidError(
          locked.status === 'ACTIVE'
            ? 'The handyman work crew is already active.'
            : 'The handyman work crew changed status concurrently; retry the transition.',
        );
      }

      const providerVendorId = await requireOperationalProviderVendor(
        locked.clientId,
        locked.handymanProviderId,
      );

      const lead = await handymanWorkCrewRepository.findActiveLead(
        locked.id,
        tx,
      );
      if (!lead) {
        throw handymanWorkCrewLeadRequiredError();
      }
      await requireValidCrewWorker(
        lead.vendorWorkforceBindingId,
        locked.clientId,
        providerVendorId,
        tx,
      );

      const transitioned = await handymanWorkCrewRepository.updateStatusFrom(
        id,
        'INACTIVE',
        'ACTIVE',
        actorUserId,
        tx,
      );
      if (!transitioned) {
        throw handymanWorkCrewStatusInvalidError(
          'The handyman work crew changed status concurrently; retry the transition.',
        );
      }

      await recordOperationalEvent(
        {
          clientId: transitioned.clientId,
          eventType: 'HANDYMAN_WORK_CREW_ACTIVATED',
          entityType: 'HANDYMAN_WORK_CREW',
          entityId: transitioned.id,
          actorUserId,
          summary: `Handyman work crew ${transitioned.crewCode} activated.`,
          metadata: { status: transitioned.status, leadMemberId: lead.id },
        },
        tx,
      );

      return transitioned;
    });

    return toPublicHandymanWorkCrew(updated);
  }

  const updated = await handymanWorkCrewRepository.updateStatusFrom(
    id,
    record.status,
    input.status,
    actorUserId,
  );
  if (!updated) {
    throw handymanWorkCrewStatusInvalidError(
      'The handyman work crew changed status concurrently; retry the transition.',
    );
  }

  await recordOperationalEvent({
    clientId: updated.clientId,
    eventType: 'HANDYMAN_WORK_CREW_DEACTIVATED',
    entityType: 'HANDYMAN_WORK_CREW',
    entityId: updated.id,
    actorUserId,
    summary: `Handyman work crew ${updated.crewCode} deactivated.`,
    metadata: { status: updated.status },
  });

  return toPublicHandymanWorkCrew(updated);
}

/**
 * Seats a worker on an ACTIVE crew through their EXISTING vendor workforce
 * binding. An INACTIVE crew is frozen and gains no operational membership.
 * A LEAD_WORKER add is rejected while the crew has its (structural, exactly
 * one) active lead — the lead only changes through `changeLeadWorker`, so
 * no zero-lead or two-lead window ever exists.
 */
export async function addHandymanWorkCrewMember(
  crewId: string,
  input: AddHandymanWorkCrewMemberInput,
  actorUserId: string,
): Promise<PublicHandymanWorkCrewMember> {
  const crew = await handymanWorkCrewRepository.findById(crewId);
  if (!crew) {
    throw handymanWorkCrewNotFoundError();
  }
  await assertClientAccess(actorUserId, crew.clientId);

  try {
    return await withTransaction(async (tx) => {
      const locked = await handymanWorkCrewRepository.lockById(crewId, tx);
      if (!locked) {
        throw handymanWorkCrewNotFoundError();
      }
      if (locked.status !== 'ACTIVE') {
        throw handymanWorkCrewStatusInvalidError(
          'An inactive handyman work crew cannot gain new members.',
        );
      }

      const providerVendorId = await requireOperationalProviderVendor(
        locked.clientId,
        locked.handymanProviderId,
      );

      if (input.crewRole === 'LEAD_WORKER') {
        const leads = await handymanWorkCrewRepository.countActiveLeads(
          locked.id,
          tx,
        );
        if (leads >= 1) {
          throw handymanWorkCrewLeadAlreadyActiveError();
        }
      }

      const duplicate =
        await handymanWorkCrewRepository.findActiveMemberByCrewAndBinding(
          locked.id,
          input.vendorWorkforceBindingId,
          tx,
        );
      if (duplicate) {
        throw handymanWorkCrewMemberAlreadyActiveError();
      }

      await requireValidCrewWorker(
        input.vendorWorkforceBindingId,
        locked.clientId,
        providerVendorId,
        tx,
      );

      const member = await handymanWorkCrewRepository.createMember(
        {
          clientId: locked.clientId,
          crewId: locked.id,
          vendorWorkforceBindingId: input.vendorWorkforceBindingId,
          crewRole: input.crewRole,
          status: 'ACTIVE',
          addedByUserId: actorUserId,
        },
        tx,
      );

      await recordOperationalEvent(
        {
          clientId: locked.clientId,
          eventType: 'HANDYMAN_WORK_CREW_MEMBER_ADDED',
          entityType: 'HANDYMAN_WORK_CREW',
          entityId: locked.id,
          actorUserId,
          summary: `Handyman work crew ${locked.crewCode} member added.`,
          metadata: {
            memberId: member.id,
            crewRole: member.crewRole,
            status: member.status,
            vendorWorkforceBindingId: member.vendorWorkforceBindingId,
          },
        },
        tx,
      );

      return toPublicHandymanWorkCrewMember(member);
    });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === MEMBER_ACTIVE_UNIQUE) {
      throw handymanWorkCrewMemberAlreadyActiveError();
    }
    if (constraint === LEAD_ACTIVE_UNIQUE) {
      throw handymanWorkCrewLeadAlreadyActiveError();
    }
    throw error;
  }
}

/**
 * Closes an ACTIVE membership with full removal attribution (guarded, so a
 * concurrent closure cannot double-remove). The ACTIVE lead of an ACTIVE
 * crew can never be removed directly — only replaced atomically through
 * `changeLeadWorker` — so the zero-lead state is unreachable. Historical
 * (INACTIVE) rows are immutable evidence and are never touched again.
 */
export async function removeHandymanWorkCrewMember(
  crewId: string,
  memberId: string,
  actorUserId: string,
): Promise<PublicHandymanWorkCrewMember> {
  const crew = await handymanWorkCrewRepository.findById(crewId);
  if (!crew) {
    throw handymanWorkCrewNotFoundError();
  }
  await assertClientAccess(actorUserId, crew.clientId);

  return withTransaction(async (tx) => {
    const locked = await handymanWorkCrewRepository.lockById(crewId, tx);
    if (!locked) {
      throw handymanWorkCrewNotFoundError();
    }
    if (locked.status !== 'ACTIVE') {
      throw handymanWorkCrewStatusInvalidError(
        'An inactive handyman work crew is frozen; its memberships cannot change.',
      );
    }

    const member = await handymanWorkCrewRepository.findMemberById(
      memberId,
      tx,
    );
    if (!member || member.crewId !== locked.id) {
      throw handymanWorkCrewMemberNotFoundError();
    }
    if (member.status !== 'ACTIVE') {
      throw handymanWorkCrewMemberStatusInvalidError(
        'The handyman work crew membership is already inactive.',
      );
    }
    if (member.crewRole === 'LEAD_WORKER') {
      throw handymanWorkCrewLeadRemovalForbiddenError();
    }

    const removed = await handymanWorkCrewRepository.deactivateMember(
      member.id,
      actorUserId,
      tx,
    );
    if (!removed) {
      throw handymanWorkCrewMemberStatusInvalidError(
        'The handyman work crew membership changed status concurrently; retry the removal.',
      );
    }

    await recordOperationalEvent(
      {
        clientId: locked.clientId,
        eventType: 'HANDYMAN_WORK_CREW_MEMBER_REMOVED',
        entityType: 'HANDYMAN_WORK_CREW',
        entityId: locked.id,
        actorUserId,
        summary: `Handyman work crew ${locked.crewCode} member removed.`,
        metadata: {
          memberId: removed.id,
          crewRole: removed.crewRole,
          status: removed.status,
        },
      },
      tx,
    );

    return toPublicHandymanWorkCrewMember(removed);
  });
}

/**
 * Atomic lead replacement: the current ACTIVE lead membership is closed and
 * the new LEAD_WORKER membership is inserted inside ONE crew-locked
 * transaction, so an ACTIVE operational crew never passes through a
 * zero-lead (or two-lead) state. The old member's historical row keeps its
 * identity and role — it is closed, never mutated. The new lead must not
 * already hold an ACTIVE membership on the crew (promotion path: remove the
 * helper membership explicitly first, then change the lead).
 */
export async function changeHandymanWorkCrewLeadWorker(
  crewId: string,
  input: ChangeHandymanWorkCrewLeadInput,
  actorUserId: string,
): Promise<{
  previousMember: PublicHandymanWorkCrewMember;
  newMember: PublicHandymanWorkCrewMember;
}> {
  const crew = await handymanWorkCrewRepository.findById(crewId);
  if (!crew) {
    throw handymanWorkCrewNotFoundError();
  }
  await assertClientAccess(actorUserId, crew.clientId);

  try {
    return await withTransaction(async (tx) => {
      const locked = await handymanWorkCrewRepository.lockById(crewId, tx);
      if (!locked) {
        throw handymanWorkCrewNotFoundError();
      }
      if (locked.status !== 'ACTIVE') {
        throw handymanWorkCrewStatusInvalidError(
          'An inactive handyman work crew is frozen; its memberships cannot change.',
        );
      }

      const providerVendorId = await requireOperationalProviderVendor(
        locked.clientId,
        locked.handymanProviderId,
      );

      const duplicate =
        await handymanWorkCrewRepository.findActiveMemberByCrewAndBinding(
          locked.id,
          input.newLeadWorkerBindingId,
          tx,
        );
      if (duplicate) {
        throw handymanWorkCrewMemberAlreadyActiveError();
      }

      await requireValidCrewWorker(
        input.newLeadWorkerBindingId,
        locked.clientId,
        providerVendorId,
        tx,
      );

      const currentLead = await handymanWorkCrewRepository.findActiveLead(
        locked.id,
        tx,
      );
      if (!currentLead) {
        // Unreachable for an ACTIVE crew under this lifecycle (a crew is
        // created with its lead and the lead only ends through this
        // command) — defensive guard so the invariant can never regress
        // silently.
        throw handymanWorkCrewLeadRequiredError();
      }

      const previousMember = await handymanWorkCrewRepository.deactivateMember(
        currentLead.id,
        actorUserId,
        tx,
      );
      if (!previousMember) {
        throw handymanWorkCrewMemberStatusInvalidError(
          'The active lead membership changed status concurrently; retry the lead change.',
        );
      }

      const newMember = await handymanWorkCrewRepository.createMember(
        {
          clientId: locked.clientId,
          crewId: locked.id,
          vendorWorkforceBindingId: input.newLeadWorkerBindingId,
          crewRole: 'LEAD_WORKER',
          status: 'ACTIVE',
          addedByUserId: actorUserId,
        },
        tx,
      );

      await recordOperationalEvent(
        {
          clientId: locked.clientId,
          eventType: 'HANDYMAN_WORK_CREW_LEAD_CHANGED',
          entityType: 'HANDYMAN_WORK_CREW',
          entityId: locked.id,
          actorUserId,
          summary: `Handyman work crew ${locked.crewCode} lead worker changed.`,
          metadata: {
            previousMemberId: previousMember.id,
            newMemberId: newMember.id,
            crewRole: newMember.crewRole,
            status: newMember.status,
          },
        },
        tx,
      );

      return {
        previousMember: toPublicHandymanWorkCrewMember(previousMember),
        newMember: toPublicHandymanWorkCrewMember(newMember),
      };
    });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === MEMBER_ACTIVE_UNIQUE) {
      throw handymanWorkCrewMemberAlreadyActiveError();
    }
    if (constraint === LEAD_ACTIVE_UNIQUE) {
      throw handymanWorkCrewLeadAlreadyActiveError();
    }
    throw error;
  }
}

/**
 * Lists a crew's memberships INCLUDING deactivated history rows — the
 * membership history is explicit, auditable evidence and a first-class read
 * surface. An optional status filter narrows to ACTIVE or INACTIVE.
 */
export async function listHandymanWorkCrewMembers(
  crewId: string,
  actorUserId: string,
  filters: HandymanWorkCrewMemberFilters = {},
): Promise<PublicHandymanWorkCrewMember[]> {
  const crew = await handymanWorkCrewRepository.findById(crewId);
  if (!crew) {
    throw handymanWorkCrewNotFoundError();
  }
  await assertClientAccess(actorUserId, crew.clientId);
  const records = await handymanWorkCrewRepository.listMembers(crewId, filters);
  return records.map(toPublicHandymanWorkCrewMember);
}

export const handymanWorkCrewService = {
  addHandymanWorkCrewMember,
  changeHandymanWorkCrewLeadWorker,
  createHandymanWorkCrew,
  getHandymanWorkCrewById,
  listHandymanWorkCrewMembers,
  listHandymanWorkCrews,
  normalizeCrewCode,
  removeHandymanWorkCrewMember,
  toPublicHandymanWorkCrew,
  toPublicHandymanWorkCrewMember,
  updateHandymanWorkCrew,
  updateHandymanWorkCrewStatus,
};
