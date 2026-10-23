import { getPool } from '../../database';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleClientIds,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { skillNotFoundError, skillRepository } from '../skills';
import { workforceProfileNotFoundError } from '../workforce';
import { skillInactiveError } from '../workforce-skills';
import {
  workforceCertificationAlreadyActiveError,
  workforceCertificationClientMismatchError,
  workforceCertificationDocumentInvalidError,
  workforceCertificationDocumentMismatchError,
  workforceCertificationForbiddenError,
  workforceCertificationNotFoundError,
  workforceCertificationSelfVerificationForbiddenError,
  workforceCertificationStatusDateMismatchError,
  workforceCertificationVerificationActorRequiredError,
  workforceCertificationVerificationNotAllowedError,
} from './workforce-certification.errors';
import {
  workforceCertificationRepository,
  type WorkforceProfileClientContext,
} from './workforce-certification.repository';
import {
  WORKFORCE_CERTIFICATION_PERMISSIONS,
  type CreateWorkforceCertificationInput,
  type DeactivateWorkforceCertificationInput,
  type ListExpiringWorkforceCertificationsFilter,
  type ListWorkforceCertificationsFilter,
  type UpdateWorkforceCertificationInput,
  type VerifyWorkforceCertificationInput,
  type WorkforceCertificationActor,
  type WorkforceCertificationExpiringItem,
  type WorkforceCertificationMobileSummary,
  type WorkforceCertificationRecord,
  type WorkforceCertificationStatus,
  type WorkforceCertificationVerificationStatus,
} from './workforce-certification.types';
import { validateSafeCertificationFileReference } from './workforce-certification.validation';

/**
 * PART 02 — authority boundary.
 *
 * Individual worker certification is its own authority domain. Exactly three
 * dedicated codes exist, and NOTHING else is accepted as a substitute:
 *
 *   - the generic tenant/ops codes (`tenant_company.*`) are too broad: they
 *     authorize tenant administration, not a worker's competence record;
 *   - `skill.*` administers the Skill CATALOG, not an individual's certificate;
 *   - `workforce.*` administers workforce master data (the person), not the
 *     evidentiary attestation attached to them;
 *   - `vendor_licenses_certifications` is company-level and is never consulted.
 *
 * The Client boundary is enforced independently of permission breadth (see
 * `ensureClientAccess`), so no permission can widen a read across Clients.
 */
const READ_PERMISSION = WORKFORCE_CERTIFICATION_PERMISSIONS.read;
const MANAGE_PERMISSION = WORKFORCE_CERTIFICATION_PERMISSIONS.manage;
const VERIFY_PERMISSION = WORKFORCE_CERTIFICATION_PERMISSIONS.verify;

function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
}

async function isActorCrewLeadForWorkforceProfile(
  actorUserId: string,
  clientId: string,
  targetWorkforceProfileId: string,
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ crew_id: string }>(
    `SELECT cm_target.handyman_crew_id AS crew_id
       FROM handyman_worker_contexts wc_target
       JOIN handyman_crew_memberships cm_target
         ON cm_target.handyman_worker_context_id = wc_target.id
        AND cm_target.client_id = wc_target.client_id
        AND cm_target.status = 'ACTIVE'
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
      WHERE wc_target.client_id = $1
        AND wc_target.workforce_profile_id = $2
        AND wc_target.status = 'ACTIVE'
        AND wp_lead.user_id = $3
      LIMIT 1`,
    [clientId, targetWorkforceProfileId, actorUserId],
  );
  return Boolean(result.rows[0]);
}

async function resolveActorPermissions(
  actor: WorkforceCertificationActor,
): Promise<string[]> {
  if (Array.isArray(actor.permissions) && actor.permissions.length > 0) {
    return [...actor.permissions];
  }
  return permissionService.resolvePermissionsForUser(actor.id);
}

async function actorHoldsPermission(
  actor: WorkforceCertificationActor | undefined,
  code: string,
): Promise<boolean> {
  if (!actor?.id) {
    return false;
  }
  const permissions = await resolveActorPermissions(actor);
  return permissions.includes(code);
}

/**
 * Client isolation is proven from the actor's OWN assignments, never from the
 * permission they hold. This runs before every read and every mutation —
 * including document-backed reads — so a wide permission can never become a
 * cross-Client read.
 */
async function ensureClientAccess(
  profile: WorkforceProfileClientContext,
  actor: WorkforceCertificationActor,
): Promise<void> {
  const canAccessClient = await contextAccessService.canAccessClient(
    actor.id,
    profile.clientId,
  );
  if (!canAccessClient) {
    throw buildingAccessDeniedError();
  }
}

async function loadWorkforceProfile(
  workforceProfileId: string,
): Promise<WorkforceProfileClientContext> {
  const profile =
    await workforceCertificationRepository.findWorkforceProfileClientContext(
      workforceProfileId,
    );
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  return profile;
}

/**
 * Read authority, in order of narrowing:
 *   1. the worker whose profile this is (self-read),
 *   2. an ACTIVE Crew Lead of an ACTIVE crew the worker is an ACTIVE member of,
 *   3. a holder of `workforce_certification.read`.
 *
 * A plain peer crew member is deliberately excluded.
 */
async function ensureReadAccess(
  profile: WorkforceProfileClientContext,
  actor?: WorkforceCertificationActor,
): Promise<void> {
  if (!actor) {
    return;
  }

  await ensureClientAccess(profile, actor);

  if (profile.userId === actor.id) {
    return;
  }

  if (await actorHoldsPermission(actor, READ_PERMISSION)) {
    return;
  }

  const isCrewLead = await isActorCrewLeadForWorkforceProfile(
    actor.id,
    profile.clientId,
    profile.id,
  );
  if (!isCrewLead) {
    throw workforceCertificationForbiddenError(
      'Actor is not authorized to read certifications for this workforce profile.',
    );
  }
}

/**
 * Manage authority (`workforce_certification.manage`). The permission alone is
 * never enough: the Client scope must also resolve for the actor.
 */
async function ensureManageAccess(
  profile: WorkforceProfileClientContext,
  actor?: WorkforceCertificationActor,
): Promise<void> {
  if (!actor) {
    return;
  }

  await ensureClientAccess(profile, actor);

  if (!(await actorHoldsPermission(actor, MANAGE_PERMISSION))) {
    throw workforceCertificationForbiddenError(
      'Actor is not authorized to manage workforce certifications.',
    );
  }
}

/**
 * Verification authority (`workforce_certification.verify`) — separation of
 * duties on top of the manage side:
 *
 *   - the dedicated verification permission is REQUIRED (manage is not enough),
 *   - the Client scope must resolve,
 *   - and the actor may never decide on a certificate whose workforce profile is
 *     their own.
 */
async function ensureVerifyAccess(
  profile: WorkforceProfileClientContext,
  actor?: WorkforceCertificationActor,
): Promise<void> {
  if (!actor?.id) {
    throw workforceCertificationVerificationActorRequiredError();
  }

  await ensureClientAccess(profile, actor);

  if (!(await actorHoldsPermission(actor, VERIFY_PERMISSION))) {
    throw workforceCertificationForbiddenError(
      'Actor is not authorized to verify or reject workforce certifications.',
    );
  }

  if (profile.userId === actor.id) {
    throw workforceCertificationSelfVerificationForbiddenError();
  }
}

async function ensureSkillInClient(
  skillId: string,
  clientId: string,
  requireActive: boolean,
): Promise<void> {
  const skill = await skillRepository.findById(skillId);
  if (!skill) {
    throw skillNotFoundError();
  }
  if (skill.clientId !== clientId) {
    throw workforceCertificationClientMismatchError(
      'Skill does not belong to the same client as the workforce profile.',
    );
  }
  if (requireActive && skill.status !== 'ACTIVE') {
    throw skillInactiveError();
  }
}

/**
 * Document references are Client-scoped: the document must exist, be ACTIVE and
 * belong to the exact same Client as the workforce profile. A document id from
 * another Client is a conflict (409), never a silent attach.
 */
async function ensureDocumentInClient(
  documentId: string,
  clientId: string,
): Promise<void> {
  const doc =
    await workforceCertificationRepository.findDocumentContext(documentId);
  if (!doc) {
    throw workforceCertificationDocumentInvalidError();
  }
  if (doc.clientId !== clientId) {
    throw workforceCertificationDocumentMismatchError();
  }
  if (doc.status === 'INACTIVE') {
    throw workforceCertificationDocumentInvalidError();
  }
}

function resolveEffectiveCertificationStatus(
  requestedStatus: WorkforceCertificationStatus | undefined,
  expiryDate: string | null,
  now: Date = new Date(),
): WorkforceCertificationStatus {
  const isPastExpiry =
    expiryDate !== null && new Date(expiryDate).getTime() < now.getTime();

  if (requestedStatus === undefined) {
    return isPastExpiry ? 'EXPIRED' : 'ACTIVE';
  }

  if (requestedStatus === 'EXPIRED' && (expiryDate === null || !isPastExpiry)) {
    throw workforceCertificationStatusDateMismatchError();
  }

  if (requestedStatus === 'ACTIVE' && isPastExpiry) {
    throw workforceCertificationStatusDateMismatchError();
  }

  return requestedStatus;
}

/**
 * PART 02 — the ONLY place a verification decision is written.
 *
 * A decision always carries the deciding actor and the decision instant; a
 * reset to PENDING_VERIFICATION clears both, because an audit trail must never
 * claim a decision that no longer holds.
 */
function resolveVerificationAuditFields(
  verificationStatus: WorkforceCertificationVerificationStatus,
  actor?: WorkforceCertificationActor,
): {
  verifiedByUserId: string | null;
  verifiedAt: string | null;
} {
  if (verificationStatus === 'PENDING_VERIFICATION') {
    return {
      verifiedByUserId: null,
      verifiedAt: null,
    };
  }

  if (!actor?.id) {
    throw workforceCertificationVerificationActorRequiredError();
  }

  return {
    verifiedByUserId: actor.id,
    verifiedAt: new Date().toISOString(),
  };
}

export const workforceCertificationService = {
  async listWorkforceCertifications(
    workforceProfileId: string,
    filter: ListWorkforceCertificationsFilter = {},
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord[]> {
    const profile = await loadWorkforceProfile(workforceProfileId);
    await ensureReadAccess(profile, actor);
    return workforceCertificationRepository.listByWorkforceProfileId(
      workforceProfileId,
      filter,
    );
  },

  async listCurrentWorkforceCertifications(
    workforceProfileId: string,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord[]> {
    const profile = await loadWorkforceProfile(workforceProfileId);
    await ensureReadAccess(profile, actor);
    return workforceCertificationRepository.listCurrentByWorkforceProfileId(
      workforceProfileId,
    );
  },

  /**
   * PART 02 — expiry watch, scoped to the caller's own Clients.
   *
   * The Client set comes from the actor's ACTIVE Building assignments (never
   * from a query parameter and never from the permission code). A caller with no
   * reachable Client gets an empty list, not a 500 and not a global read.
   */
  async listExpiringWorkforceCertifications(
    filter: ListExpiringWorkforceCertificationsFilter,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationExpiringItem[]> {
    if (!actor?.id) {
      throw workforceCertificationForbiddenError(
        'Actor is not authorized to read workforce certifications.',
      );
    }

    if (!(await actorHoldsPermission(actor, READ_PERMISSION))) {
      throw workforceCertificationForbiddenError(
        'Actor is not authorized to read workforce certifications.',
      );
    }

    const clientIds = await getAccessibleClientIds(actor.id);
    return workforceCertificationRepository.listExpiring(clientIds, filter);
  },

  async getWorkforceCertificationById(
    workforceProfileId: string,
    certificationId: string,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    const profile = await loadWorkforceProfile(workforceProfileId);
    await ensureReadAccess(profile, actor);
    const record =
      await workforceCertificationRepository.findByIdInWorkforceProfile(
        workforceProfileId,
        certificationId,
      );
    if (!record) {
      throw workforceCertificationNotFoundError();
    }
    return record;
  },

  /**
   * PART 02 — every certification is created PENDING_VERIFICATION.
   *
   * A create can never mint a VERIFIED attestation: that would let a
   * manage-only actor bypass the verification authority entirely.
   */
  async createWorkforceCertification(
    workforceProfileId: string,
    input: CreateWorkforceCertificationInput,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    const profile = await loadWorkforceProfile(workforceProfileId);
    await ensureManageAccess(profile, actor);

    const skillId = input.skillId ?? null;
    if (skillId !== null) {
      await ensureSkillInClient(skillId, profile.clientId, true);
    }

    const documentId = input.documentId ?? null;
    if (documentId !== null) {
      await ensureDocumentInClient(documentId, profile.clientId);
    }

    const fileReference =
      input.fileReference !== undefined && input.fileReference !== null
        ? validateSafeCertificationFileReference(input.fileReference)
        : null;

    const expiryDate = input.expiryDate ?? null;
    const status = resolveEffectiveCertificationStatus(
      input.status,
      expiryDate,
    );

    if (status === 'ACTIVE') {
      const existingActive =
        await workforceCertificationRepository.findActiveDuplicate(
          workforceProfileId,
          input.certificateNumber,
        );
      if (existingActive) {
        throw workforceCertificationAlreadyActiveError();
      }
    }

    let created: WorkforceCertificationRecord;
    try {
      created = await workforceCertificationRepository.create({
        clientId: profile.clientId,
        workforceProfileId,
        skillId,
        certificateNumber: input.certificateNumber,
        certificateName: input.certificateName,
        issuingAuthority: input.issuingAuthority,
        issueDate: input.issueDate,
        expiryDate,
        status,
        verificationStatus: 'PENDING_VERIFICATION',
        verifiedByUserId: null,
        verifiedAt: null,
        documentId,
        fileReference,
        notes: input.notes ?? null,
        createdByUserId: actor?.id ?? null,
      });
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw workforceCertificationAlreadyActiveError();
      }
      throw err;
    }

    if (actor) {
      await recordOperationalEvent({
        clientId: profile.clientId,
        eventType: 'WORKFORCE_CERTIFICATION_CREATED',
        entityType: 'WORKFORCE_CERTIFICATION',
        entityId: created.id,
        actorUserId: actor.id,
        summary: `Workforce certification ${created.certificateNumber} created`,
        metadata: {
          workforceProfileId,
          certificateNumber: created.certificateNumber,
          status: created.status,
          verificationStatus: created.verificationStatus,
          skillId: created.skillId,
          documentId: created.documentId,
        },
      });
    }

    return created;
  },

  /**
   * PART 02 — metadata only.
   *
   * `verificationStatus` is not an updatable field: the verification decision
   * has its own authority and its own endpoint, so a metadata edit can never
   * silently attest competence. The status/expiry-date consistency rules are
   * re-evaluated against the STORED record on every partial update.
   */
  async updateWorkforceCertification(
    workforceProfileId: string,
    certificationId: string,
    input: UpdateWorkforceCertificationInput,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    const profile = await loadWorkforceProfile(workforceProfileId);
    await ensureManageAccess(profile, actor);

    const existing =
      await workforceCertificationRepository.findByIdInWorkforceProfile(
        workforceProfileId,
        certificationId,
      );
    if (!existing) {
      throw workforceCertificationNotFoundError();
    }

    if (input.skillId !== undefined && input.skillId !== null) {
      const isChangingSkill = input.skillId !== existing.skillId;
      await ensureSkillInClient(
        input.skillId,
        profile.clientId,
        isChangingSkill,
      );
    }

    if (input.documentId !== undefined && input.documentId !== null) {
      await ensureDocumentInClient(input.documentId, profile.clientId);
    }

    const nextFileReference =
      input.fileReference !== undefined
        ? input.fileReference === null
          ? null
          : validateSafeCertificationFileReference(input.fileReference)
        : undefined;

    const nextIssueDate = input.issueDate ?? existing.issueDate;
    const nextExpiryDate =
      input.expiryDate !== undefined ? input.expiryDate : existing.expiryDate;

    if (
      nextExpiryDate !== null &&
      new Date(nextExpiryDate).getTime() < new Date(nextIssueDate).getTime()
    ) {
      throw workforceCertificationStatusDateMismatchError();
    }

    let nextStatus: WorkforceCertificationStatus;
    if (input.status !== undefined) {
      nextStatus = resolveEffectiveCertificationStatus(
        input.status,
        nextExpiryDate,
      );
    } else if (input.expiryDate !== undefined && existing.status !== 'INACTIVE') {
      nextStatus = resolveEffectiveCertificationStatus(
        undefined,
        nextExpiryDate,
      );
    } else {
      nextStatus = existing.status;
    }

    const nextCertificateNumber =
      input.certificateNumber ?? existing.certificateNumber;

    if (nextStatus === 'ACTIVE') {
      const duplicate =
        await workforceCertificationRepository.findActiveDuplicate(
          workforceProfileId,
          nextCertificateNumber,
          certificationId,
        );
      if (duplicate) {
        throw workforceCertificationAlreadyActiveError();
      }
    }

    let updated: WorkforceCertificationRecord | null;
    try {
      updated = await workforceCertificationRepository.update(certificationId, {
        ...(input.skillId !== undefined ? { skillId: input.skillId } : {}),
        ...(input.certificateNumber !== undefined
          ? { certificateNumber: input.certificateNumber }
          : {}),
        ...(input.certificateName !== undefined
          ? { certificateName: input.certificateName }
          : {}),
        ...(input.issuingAuthority !== undefined
          ? { issuingAuthority: input.issuingAuthority }
          : {}),
        ...(input.issueDate !== undefined ? { issueDate: input.issueDate } : {}),
        ...(input.expiryDate !== undefined
          ? { expiryDate: input.expiryDate }
          : {}),
        status: nextStatus,
        ...(input.documentId !== undefined
          ? { documentId: input.documentId }
          : {}),
        ...(nextFileReference !== undefined
          ? { fileReference: nextFileReference }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        throw workforceCertificationAlreadyActiveError();
      }
      throw err;
    }

    if (!updated) {
      throw workforceCertificationNotFoundError();
    }

    if (actor) {
      await recordOperationalEvent({
        clientId: profile.clientId,
        eventType: 'WORKFORCE_CERTIFICATION_UPDATED',
        entityType: 'WORKFORCE_CERTIFICATION',
        entityId: updated.id,
        actorUserId: actor.id,
        summary: `Workforce certification ${updated.certificateNumber} updated`,
        metadata: {
          workforceProfileId,
          status: updated.status,
          verificationStatus: updated.verificationStatus,
        },
      });
    }

    return updated;
  },

  /**
   * PART 02 — verify / reject.
   *
   * Rules enforced here (not in the transport):
   *   - the actor must hold `workforce_certification.verify`,
   *   - the actor must reach the Client of the workforce profile,
   *   - the actor may never decide on their OWN certificate,
   *   - an INACTIVE or already-expired certificate can never become VERIFIED.
   */
  async verifyWorkforceCertification(
    workforceProfileId: string,
    certificationId: string,
    input: VerifyWorkforceCertificationInput,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    const profile = await loadWorkforceProfile(workforceProfileId);
    await ensureVerifyAccess(profile, actor);

    const existing =
      await workforceCertificationRepository.findByIdInWorkforceProfile(
        workforceProfileId,
        certificationId,
      );
    if (!existing) {
      throw workforceCertificationNotFoundError();
    }

    if (input.verificationStatus === 'VERIFIED') {
      if (existing.status === 'INACTIVE') {
        throw workforceCertificationVerificationNotAllowedError(
          'A deactivated certificate can never be marked VERIFIED.',
        );
      }
      if (existing.isExpired) {
        throw workforceCertificationVerificationNotAllowedError(
          'An expired certificate can never be marked VERIFIED.',
        );
      }
    }

    const audit = resolveVerificationAuditFields(
      input.verificationStatus,
      actor,
    );

    const updated = await workforceCertificationRepository.update(
      certificationId,
      {
        verificationStatus: input.verificationStatus,
        verifiedByUserId: audit.verifiedByUserId,
        verifiedAt: audit.verifiedAt,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    );

    if (!updated) {
      throw workforceCertificationNotFoundError();
    }

    if (actor) {
      await recordOperationalEvent({
        clientId: profile.clientId,
        eventType: 'WORKFORCE_CERTIFICATION_VERIFIED',
        entityType: 'WORKFORCE_CERTIFICATION',
        entityId: updated.id,
        actorUserId: actor.id,
        summary: `Workforce certification ${updated.certificateNumber} verification status set to ${updated.verificationStatus}`,
        metadata: {
          workforceProfileId,
          previousVerificationStatus: existing.verificationStatus,
          verificationStatus: updated.verificationStatus,
          certificateExpiryStatus: updated.expiryStatus,
        },
      });
    }

    return updated;
  },

  async deactivateWorkforceCertification(
    workforceProfileId: string,
    certificationId: string,
    actor?: WorkforceCertificationActor,
    input: DeactivateWorkforceCertificationInput = {},
  ): Promise<WorkforceCertificationRecord> {
    const profile = await loadWorkforceProfile(workforceProfileId);
    await ensureManageAccess(profile, actor);

    const existing =
      await workforceCertificationRepository.findByIdInWorkforceProfile(
        workforceProfileId,
        certificationId,
      );
    if (!existing) {
      throw workforceCertificationNotFoundError();
    }

    const updated = await workforceCertificationRepository.update(
      certificationId,
      {
        status: 'INACTIVE',
      },
    );

    if (!updated) {
      throw workforceCertificationNotFoundError();
    }

    if (actor) {
      await recordOperationalEvent({
        clientId: profile.clientId,
        eventType: 'WORKFORCE_CERTIFICATION_DEACTIVATED',
        entityType: 'WORKFORCE_CERTIFICATION',
        entityId: updated.id,
        actorUserId: actor.id,
        summary: `Workforce certification ${updated.certificateNumber} deactivated`,
        metadata: {
          workforceProfileId,
          previousStatus: existing.status,
          status: updated.status,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    }

    return updated;
  },

  /**
   * PART 02 — Mobile profile projection source.
   *
   * Reads the worker's own certificates (ACTIVE + EXPIRED, never INACTIVE)
   * pinned to the profile's authoritative Client. Certifications are optional:
   * a worker with none yields an empty array.
   */
  async projectMobileCertifications(
    workforceProfileId: string,
    clientId: string,
  ): Promise<WorkforceCertificationMobileSummary[]> {
    const records =
      await workforceCertificationRepository.listVisibleByWorkforceProfileId(
        workforceProfileId,
        clientId,
      );
    return records.map(toMobileCertificationSummary);
  },
};

/**
 * Projects one stored record into the Mobile contract.
 *
 * The raw `file_reference` storage key is deliberately NOT exposed: the Mobile
 * client only learns whether a document is available and which document id it
 * belongs to, so a download endpoint (or none at all) keeps its own scope.
 */
export function toMobileCertificationSummary(
  record: WorkforceCertificationRecord,
): WorkforceCertificationMobileSummary {
  return {
    id: record.id,
    certificateNumber: record.certificateNumber,
    certificateName: record.certificateName,
    issuingAuthority: record.issuingAuthority,
    skillId: record.skillId,
    skillCode: record.skill?.code ?? null,
    skillName: record.skill?.name ?? null,
    status: record.status,
    verificationStatus: record.verificationStatus,
    issueDate: record.issueDate,
    expiryDate: record.expiryDate,
    expiryStatus: record.expiryStatus,
    isExpired: record.isExpired,
    isValid: record.isValid,
    documentAvailable: Boolean(record.fileReference),
    documentId: record.documentId,
  };
}
