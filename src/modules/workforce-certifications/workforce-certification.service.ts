import { getPool } from '../../database';
import {
  buildingAccessDeniedError,
  contextAccessService,
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
  workforceCertificationStatusDateMismatchError,
  workforceCertificationVerificationActorRequiredError,
} from './workforce-certification.errors';
import {
  workforceCertificationRepository,
  type WorkforceProfileClientContext,
} from './workforce-certification.repository';
import type {
  CreateWorkforceCertificationInput,
  ListWorkforceCertificationsFilter,
  UpdateWorkforceCertificationInput,
  VerifyWorkforceCertificationInput,
  WorkforceCertificationActor,
  WorkforceCertificationRecord,
  WorkforceCertificationStatus,
  WorkforceCertificationVerificationStatus,
} from './workforce-certification.types';
import { validateSafeCertificationFileReference } from './workforce-certification.validation';

const READ_PERMISSIONS = [
  'skill.read',
  'skill.manage',
  'workforce.read',
  'workforce.manage',
  'tenant_company.read',
  'tenant_company.manage',
] as const;

const MANAGE_PERMISSIONS = [
  'skill.manage',
  'workforce.manage',
  'tenant_company.manage',
] as const;

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

async function ensureWorkforceProfileAndReadAccess(
  workforceProfileId: string,
  actor?: WorkforceCertificationActor,
): Promise<WorkforceProfileClientContext> {
  const profile =
    await workforceCertificationRepository.findWorkforceProfileClientContext(
      workforceProfileId,
    );
  if (!profile) {
    throw workforceProfileNotFoundError();
  }

  if (actor) {
    const canAccessClient = await contextAccessService.canAccessClient(
      actor.id,
      profile.clientId,
    );
    if (!canAccessClient) {
      throw buildingAccessDeniedError();
    }

    if (profile.userId !== actor.id) {
      const perms = await resolveActorPermissions(actor);
      const hasReadPerm = READ_PERMISSIONS.some((p) => perms.includes(p));
      if (!hasReadPerm) {
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
    }
  }

  return profile;
}

async function ensureWorkforceProfileAndManageAccess(
  workforceProfileId: string,
  actor?: WorkforceCertificationActor,
): Promise<WorkforceProfileClientContext> {
  const profile =
    await workforceCertificationRepository.findWorkforceProfileClientContext(
      workforceProfileId,
    );
  if (!profile) {
    throw workforceProfileNotFoundError();
  }

  if (actor) {
    const canAccessClient = await contextAccessService.canAccessClient(
      actor.id,
      profile.clientId,
    );
    if (!canAccessClient) {
      throw buildingAccessDeniedError();
    }

    const perms = await resolveActorPermissions(actor);
    const hasManagePerm = MANAGE_PERMISSIONS.some((p) => perms.includes(p));
    if (!hasManagePerm) {
      throw workforceCertificationForbiddenError(
        'Actor is not authorized to manage workforce certifications.',
      );
    }
  }

  return profile;
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

function resolveVerificationAuditFields(
  verificationStatus: WorkforceCertificationVerificationStatus,
  actor?: WorkforceCertificationActor,
  existing?: {
    verificationStatus: WorkforceCertificationVerificationStatus;
    verifiedByUserId: string | null;
    verifiedAt: string | null;
  },
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

  if (
    existing &&
    existing.verificationStatus === verificationStatus &&
    existing.verifiedByUserId &&
    existing.verifiedAt &&
    !actor
  ) {
    return {
      verifiedByUserId: existing.verifiedByUserId,
      verifiedAt: existing.verifiedAt,
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
    await ensureWorkforceProfileAndReadAccess(workforceProfileId, actor);
    return workforceCertificationRepository.listByWorkforceProfileId(
      workforceProfileId,
      filter,
    );
  },

  async listCurrentWorkforceCertifications(
    workforceProfileId: string,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord[]> {
    await ensureWorkforceProfileAndReadAccess(workforceProfileId, actor);
    return workforceCertificationRepository.listCurrentByWorkforceProfileId(
      workforceProfileId,
    );
  },

  async getWorkforceCertificationById(
    workforceProfileId: string,
    certificationId: string,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    await ensureWorkforceProfileAndReadAccess(workforceProfileId, actor);
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

  async createWorkforceCertification(
    workforceProfileId: string,
    input: CreateWorkforceCertificationInput,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    const profile = await ensureWorkforceProfileAndManageAccess(
      workforceProfileId,
      actor,
    );

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

    const verificationStatus: WorkforceCertificationVerificationStatus =
      input.verificationStatus ?? 'PENDING_VERIFICATION';
    const verificationAudit = resolveVerificationAuditFields(
      verificationStatus,
      actor,
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
        verificationStatus,
        verifiedByUserId: verificationAudit.verifiedByUserId,
        verifiedAt: verificationAudit.verifiedAt,
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

  async updateWorkforceCertification(
    workforceProfileId: string,
    certificationId: string,
    input: UpdateWorkforceCertificationInput,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    const profile = await ensureWorkforceProfileAndManageAccess(
      workforceProfileId,
      actor,
    );

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

    let verificationPatch: {
      verificationStatus?: WorkforceCertificationVerificationStatus;
      verifiedByUserId?: string | null;
      verifiedAt?: string | null;
    } = {};

    if (input.verificationStatus !== undefined) {
      const audit = resolveVerificationAuditFields(
        input.verificationStatus,
        actor,
        existing,
      );
      verificationPatch = {
        verificationStatus: input.verificationStatus,
        verifiedByUserId: audit.verifiedByUserId,
        verifiedAt: audit.verifiedAt,
      };
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
        ...verificationPatch,
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

  async verifyWorkforceCertification(
    workforceProfileId: string,
    certificationId: string,
    input: VerifyWorkforceCertificationInput,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    const profile = await ensureWorkforceProfileAndManageAccess(
      workforceProfileId,
      actor,
    );

    const existing =
      await workforceCertificationRepository.findByIdInWorkforceProfile(
        workforceProfileId,
        certificationId,
      );
    if (!existing) {
      throw workforceCertificationNotFoundError();
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
        },
      });
    }

    return updated;
  },

  async deactivateWorkforceCertification(
    workforceProfileId: string,
    certificationId: string,
    actor?: WorkforceCertificationActor,
  ): Promise<WorkforceCertificationRecord> {
    const profile = await ensureWorkforceProfileAndManageAccess(
      workforceProfileId,
      actor,
    );

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
        },
      });
    }

    return updated;
  },
};
