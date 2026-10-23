import { AppError, ERROR_CODES } from '../../shared/errors';
import type { PoolClient } from 'pg';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import {
  meetsMinimumProficiency,
  normalizeCertificateName,
  serviceCompetencyRequirementRepository,
  type CompetencyRequirementRecord,
} from '../service-competency-requirements';
import {
  resolveWorkforceCertificationExpiryStatus,
  type WorkforceCertificationStatus,
} from '../workforce-certifications';
import { workerCompetencyEligibilityRepository as repository } from './worker-competency-eligibility.repository';
import type {
  CompetencyCandidateReport,
  CompetencyEvidence,
  CompetencyEvaluationSummary,
  CompetencyGapEvidence,
  CompetencyGapReason,
  CompetencyRequirementEvaluation,
  CrewCompetencyEligibilityReport,
  CrewWorkerRow,
  WorkerCertificationRow,
  WorkerCompetencyEligibility,
  WorkerSkillRow,
} from './worker-competency-eligibility.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — the single competency evaluator.
 *
 * Used by exactly two callers:
 *   1. the EXISTING assignment authority (`handyman-scope-assignment.service.ts`)
 *      for assign/reassign enforcement — blocking gaps throw;
 *   2. the read-only eligibility/candidates API — gaps are returned.
 *
 * Because both go through this one function, the API can never report a worker
 * as eligible when the assignment would reject them (and vice versa).
 *
 * Rules (fixed for PART 03A):
 *   - A requirement applies only when its status is ACTIVE. A job type with no
 *     ACTIVE requirement is unrestricted (pre-PART-03A behaviour).
 *   - MANDATORY gaps block; RECOMMENDED gaps are advisory.
 *   - EVERY ACTIVE crew member must satisfy every MANDATORY requirement: a crew
 *     works as one unit, and an unqualified helper is exactly the exposure this
 *     CR closes.
 *   - A certification counts only when it is ACTIVE, VERIFIED and not expired
 *     (the PART 02 `isValid` rule, reused through the shared expiry resolver).
 *   - A skill counts only inside its effective validity window, at or above the
 *     configured minimum proficiency.
 */

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isCertificationValid(
  certification: WorkerCertificationRow,
  now: Date,
): boolean {
  if (certification.status !== 'ACTIVE') return false;
  if (certification.verificationStatus !== 'VERIFIED') return false;
  const expiryStatus = resolveWorkforceCertificationExpiryStatus(
    certification.status as WorkforceCertificationStatus,
    toIso(certification.expiryDate),
    now,
  );
  return expiryStatus !== 'EXPIRED';
}

function certificateMatches(
  requirement: CompetencyRequirementRecord,
  certification: WorkerCertificationRow,
): boolean {
  if (requirement.certificateName === null) return false;
  const required = normalizeCertificateName(requirement.certificateName);
  if (normalizeCertificateName(certification.certificateName) !== required) {
    return false;
  }
  // Optional skill narrowing: when the requirement names a skill, the
  // certificate must be linked to that skill.
  if (requirement.skillId !== null && certification.skillId !== requirement.skillId) {
    return false;
  }
  return true;
}

function evidenceFor(
  certification: WorkerCertificationRow,
): CompetencyEvidence {
  return {
    proficiencyLevel: null,
    certificationId: certification.id,
    certificateNumber: certification.certificateNumber,
    certificateName: certification.certificateName,
    issuingAuthority: certification.issuingAuthority,
    verificationStatus: certification.verificationStatus,
    issueDate: toIso(certification.issueDate),
    expiryDate: toIso(certification.expiryDate),
  };
}

function gapEvidenceFor(
  certification: WorkerCertificationRow | null,
  proficiencyLevel: CompetencyEvidence['proficiencyLevel'] = null,
): CompetencyGapEvidence {
  if (!certification) {
    return {
      certificationId: null,
      certificateNumber: null,
      verificationStatus: null,
      status: null,
      expiryDate: null,
      proficiencyLevel,
    };
  }
  return {
    certificationId: certification.id,
    certificateNumber: certification.certificateNumber,
    verificationStatus: certification.verificationStatus,
    status: certification.status,
    expiryDate: toIso(certification.expiryDate),
    proficiencyLevel,
  };
}

/**
 * Picks the certificate that best explains a failed requirement. Prefers the
 * most recently issued name-matching certificate so the reason refers to the
 * document Operations is actually looking at.
 */
function closestCertificate(
  matches: WorkerCertificationRow[],
): WorkerCertificationRow | null {
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => {
    const aTime = new Date(a.issueDate as string | Date).getTime();
    const bTime = new Date(b.issueDate as string | Date).getTime();
    return bTime - aTime;
  });
  return sorted[0] ?? null;
}

function certifyReason(
  matches: WorkerCertificationRow[],
  now: Date,
): CompetencyGapReason {
  // A currently-in-window certificate that is merely unverified outranks an
  // older expired one: fixing verification is the actionable next step.
  const inWindow = matches.filter(
    (certification) =>
      certification.status === 'ACTIVE' &&
      resolveWorkforceCertificationExpiryStatus(
        certification.status as WorkforceCertificationStatus,
        toIso(certification.expiryDate),
        now,
      ) === 'VALID',
  );
  if (inWindow.length > 0) return 'CERTIFICATION_UNVERIFIED';

  const expired = matches.filter(
    (certification) =>
      certification.status === 'EXPIRED' ||
      resolveWorkforceCertificationExpiryStatus(
        certification.status as WorkforceCertificationStatus,
        toIso(certification.expiryDate),
        now,
      ) === 'EXPIRED',
  );
  if (expired.length > 0) return 'CERTIFICATION_EXPIRED';

  return 'CERTIFICATION_INACTIVE';
}

function evaluateRequirement(
  requirement: CompetencyRequirementRecord,
  skills: WorkerSkillRow[],
  certifications: WorkerCertificationRow[],
  now: Date,
): CompetencyRequirementEvaluation {
  const base = {
    requirementId: requirement.id,
    requirementType: requirement.requirementType,
    enforcementLevel: requirement.enforcementLevel,
    skillId: requirement.skillId,
    skillCode: requirement.skill?.code ?? null,
    skillName: requirement.skill?.name ?? null,
    minimumProficiencyLevel: requirement.minimumProficiencyLevel,
    certificateName: requirement.certificateName,
  };

  if (requirement.requirementType === 'SKILL') {
    const assignment = requirement.skillId
      ? skills.find((skill) => skill.skillId === requirement.skillId)
      : undefined;
    if (!assignment) {
      return {
        ...base,
        satisfied: false,
        reason: 'SKILL_MISSING',
        evidence: null,
        gapEvidence: gapEvidenceFor(null),
      };
    }
    const satisfied =
      requirement.minimumProficiencyLevel !== null &&
      meetsMinimumProficiency(
        assignment.proficiencyLevel,
        requirement.minimumProficiencyLevel,
      );
    return {
      ...base,
      satisfied,
      reason: satisfied ? null : 'PROFICIENCY_INSUFFICIENT',
      evidence: satisfied
        ? {
            proficiencyLevel: assignment.proficiencyLevel,
            certificationId: null,
            certificateNumber: null,
            certificateName: null,
            issuingAuthority: null,
            verificationStatus: null,
            issueDate: null,
            expiryDate: null,
          }
        : null,
      gapEvidence: satisfied
        ? null
        : gapEvidenceFor(null, assignment.proficiencyLevel),
    };
  }

  const matches = certifications.filter((certification) =>
    certificateMatches(requirement, certification),
  );
  const valid = matches.find((certification) =>
    isCertificationValid(certification, now),
  );
  if (valid) {
    return {
      ...base,
      satisfied: true,
      reason: null,
      evidence: evidenceFor(valid),
      gapEvidence: null,
    };
  }

  return {
    ...base,
    satisfied: false,
    reason:
      matches.length === 0
        ? 'CERTIFICATION_MISSING'
        : certifyReason(matches, now),
    evidence: null,
    gapEvidence: gapEvidenceFor(closestCertificate(matches)),
  };
}

function summarize(
  requirements: CompetencyRequirementRecord[],
): CompetencyEvaluationSummary {
  return {
    requirementCount: requirements.length,
    mandatoryRequirementCount: requirements.filter(
      (requirement) => requirement.enforcementLevel === 'MANDATORY',
    ).length,
    recommendedRequirementCount: requirements.filter(
      (requirement) => requirement.enforcementLevel === 'RECOMMENDED',
    ).length,
    requirementsConfigured: requirements.length > 0,
  };
}

function evaluateWorker(
  worker: CrewWorkerRow,
  requirements: CompetencyRequirementRecord[],
  skills: WorkerSkillRow[],
  certifications: WorkerCertificationRow[],
  now: Date,
): WorkerCompetencyEligibility {
  const evaluations = requirements.map((requirement) =>
    evaluateRequirement(requirement, skills, certifications, now),
  );
  const fails = evaluations.filter((evaluation) => !evaluation.satisfied);
  const blockingGaps = fails.filter(
    (evaluation) => evaluation.enforcementLevel === 'MANDATORY',
  );
  const advisoryGaps = fails.filter(
    (evaluation) => evaluation.enforcementLevel === 'RECOMMENDED',
  );
  return {
    workerContextId: worker.workerContextId,
    workforceProfileId: worker.workforceProfileId,
    workforceProfileName: worker.workforceProfileName,
    isLead: worker.isLead,
    eligible: blockingGaps.length === 0,
    blockingGaps,
    advisoryGaps,
    satisfiedCount: evaluations.length - fails.length,
    requirementsEvaluated: evaluations.length,
  };
}

/**
 * Crew-level roll-up. A crew-level `blockingGaps` entry is the union of its
 * members' gaps, de-duplicated per (requirement, reason) so the caller sees one
 * row per reason instead of one row per affected worker.
 */
function rollUpGaps(
  workers: WorkerCompetencyEligibility[],
  level: 'MANDATORY' | 'RECOMMENDED',
): CompetencyRequirementEvaluation[] {
  const seen = new Map<string, CompetencyRequirementEvaluation>();
  for (const worker of workers) {
    const gaps =
      level === 'MANDATORY' ? worker.blockingGaps : worker.advisoryGaps;
    for (const gap of gaps) {
      const key = `${gap.requirementId}:${gap.reason ?? 'UNKNOWN'}`;
      if (!seen.has(key)) seen.set(key, gap);
    }
  }
  return [...seen.values()];
}

type EvaluateInput = {
  executionScopeId: string;
  clientId: string;
  serviceCatalogId: string;
  crewIds: string[];
};

async function evaluateCrews(
  executor: Pick<PoolClient, 'query'> | undefined,
  input: EvaluateInput,
): Promise<{
  requirements: CompetencyRequirementRecord[];
  workersByCrew: Map<string, WorkerCompetencyEligibility[]>;
}> {
  const requirements =
    await serviceCompetencyRequirementRepository.listActiveByServiceCatalog(
      executor,
      input.serviceCatalogId,
    );

  const workers = await repository.listCrewWorkers(executor, input.crewIds);
  const workersByCrew = new Map<string, WorkerCompetencyEligibility[]>();

  if (requirements.length === 0) {
    // Fast path: an unrestricted job type costs one membership read and never
    // touches skills or certificates.
    for (const crewId of input.crewIds) {
      workersByCrew.set(
        crewId,
        workers
          .filter((worker) => worker.crewId === crewId)
          .map((worker) => ({
            workerContextId: worker.workerContextId,
            workforceProfileId: worker.workforceProfileId,
            workforceProfileName: worker.workforceProfileName,
            isLead: worker.isLead,
            eligible: true,
            blockingGaps: [],
            advisoryGaps: [],
            satisfiedCount: 0,
            requirementsEvaluated: 0,
          })),
      );
    }
    return { requirements, workersByCrew };
  }

  const profileIds = [...new Set(workers.map((worker) => worker.workforceProfileId))];
  const [skills, certifications] = await Promise.all([
    repository.listEffectiveSkills(executor, profileIds),
    repository.listCertificationsForProfiles(
        executor as Pick<PoolClient, 'query'>,
        input.clientId,
        profileIds,
      ),
  ]);
  const now = new Date();

  for (const crewId of input.crewIds) {
    workersByCrew.set(
      crewId,
      workers
        .filter((worker) => worker.crewId === crewId)
        .map((worker) =>
          evaluateWorker(
            worker,
            requirements,
            skills.filter(
              (skill) => skill.workforceProfileId === worker.workforceProfileId,
            ),
            certifications.filter(
              (certification) =>
                certification.workforceProfileId === worker.workforceProfileId,
            ),
            now,
          ),
        ),
    );
  }

  return { requirements, workersByCrew };
}

/**
 * Enforcement hook for the assignment authority. Returns the summary so the
 * caller can journal that the check actually ran (including the "no
 * requirement configured" case).
 *
 * Throws a 409 with one `details` entry per blocking gap. The error code is
 * intentionally a NEW code: it lets clients distinguish "your crew is not
 * competent for this job type" from every existing assignment conflict, while
 * the status code keeps the flow's 409 conflict convention.
 */
export async function assertExecutionScopeCompetencyEligible(
  executor: Pick<PoolClient, 'query'>,
  input: { executionScopeId: string; clientId: string; crewId: string },
): Promise<CompetencyEvaluationSummary> {
  const jobType = await repository.resolveScopeJobType(
    executor,
    input.executionScopeId,
  );
  if (!jobType || jobType.clientId !== input.clientId) {
    throw handymanExecutionScopeNotFoundError();
  }

  const { requirements, workersByCrew } = await evaluateCrews(executor, {
    executionScopeId: input.executionScopeId,
    clientId: input.clientId,
    serviceCatalogId: jobType.serviceCatalogId,
    crewIds: [input.crewId],
  });

  const workers = workersByCrew.get(input.crewId) ?? [];
  const blocking = workers.flatMap((worker) =>
    worker.blockingGaps.map((gap) => ({
      workerContextId: worker.workerContextId,
      workforceProfileId: worker.workforceProfileId,
      workforceProfileName: worker.workforceProfileName,
      requirementId: gap.requirementId,
      requirementType: gap.requirementType,
      skillCode: gap.skillCode,
      certificateName: gap.certificateName,
      minimumProficiencyLevel: gap.minimumProficiencyLevel,
      reason: gap.reason,
    })),
  );

  if (blocking.length > 0) {
    throw new AppError({
      code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_COMPETENCY_REQUIRED,
      message:
        'Every ACTIVE crew member must satisfy the mandatory competency ' +
        'requirements of this job type before the crew can be assigned.',
      statusCode: 409,
      details: blocking,
    });
  }

  return summarize(requirements);
}

/** Read-only preflight for one crew: "would this assignment be accepted?" */
export async function getCrewCompetencyEligibility(
  executionScopeId: string,
  crewId: string,
  actorUserId: string,
): Promise<CrewCompetencyEligibilityReport> {
  const jobType = await repository.resolveScopeJobType(undefined, executionScopeId);
  if (!jobType) throw handymanExecutionScopeNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: jobType.clientId,
    buildingId: jobType.buildingId,
  });

  const { requirements, workersByCrew } = await evaluateCrews(undefined, {
    executionScopeId,
    clientId: jobType.clientId,
    serviceCatalogId: jobType.serviceCatalogId,
    crewIds: [crewId],
  });
  const workers = workersByCrew.get(crewId) ?? [];
  const blockingGaps = rollUpGaps(workers, 'MANDATORY');
  return {
    executionScopeId,
    serviceCatalogId: jobType.serviceCatalogId,
    serviceCatalogCode: jobType.serviceCatalogCode,
    crewId,
    summary: summarize(requirements),
    eligible: blockingGaps.length === 0,
    workers,
    blockingGaps,
    advisoryGaps: rollUpGaps(workers, 'RECOMMENDED'),
  };
}

/**
 * Qualified-candidate read model: every ACTIVE crew of the same Client, with
 * the competency verdict and the reasons for it. Crews without an ACTIVE
 * member are excluded — they are not candidates for any job.
 */
export async function listCompetencyCandidates(
  executionScopeId: string,
  actorUserId: string,
): Promise<CompetencyCandidateReport> {
  const jobType = await repository.resolveScopeJobType(undefined, executionScopeId);
  if (!jobType) throw handymanExecutionScopeNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: jobType.clientId,
    buildingId: jobType.buildingId,
  });

  const crews = await repository.listCandidateCrews(undefined, jobType.clientId);
  const { requirements, workersByCrew } = await evaluateCrews(undefined, {
    executionScopeId,
    clientId: jobType.clientId,
    serviceCatalogId: jobType.serviceCatalogId,
    crewIds: crews.map((crew) => crew.crewId),
  });

  const candidates = crews
    .map((crew) => {
      const workers = workersByCrew.get(crew.crewId) ?? [];
      const blockingGaps = rollUpGaps(workers, 'MANDATORY');
      return {
        crewId: crew.crewId,
        crewCode: crew.crewCode,
        crewName: crew.crewName,
        providerContextId: crew.providerContextId,
        providerContextStatus: crew.providerContextStatus,
        competencyEligible: blockingGaps.length === 0,
        blockingGaps,
        advisoryGaps: rollUpGaps(workers, 'RECOMMENDED'),
        workers,
      };
    })
    .filter((candidate) => candidate.workers.length > 0);

  return {
    executionScopeId,
    serviceCatalogId: jobType.serviceCatalogId,
    serviceCatalogCode: jobType.serviceCatalogCode,
    summary: summarize(requirements),
    candidates,
    eligibleCandidateCount: candidates.filter(
      (candidate) => candidate.competencyEligible,
    ).length,
  };
}

export const workerCompetencyEligibilityService = {
  assertExecutionScopeCompetencyEligible,
  getCrewCompetencyEligibility,
  listCompetencyCandidates,
};
