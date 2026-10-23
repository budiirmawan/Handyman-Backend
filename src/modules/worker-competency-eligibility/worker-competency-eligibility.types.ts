/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — eligibility evaluation read model.
 *
 * The evaluator answers one question, for a job type and a set of workers:
 * "does this worker currently satisfy every MANDATORY competency requirement,
 * and if not, exactly why?"
 *
 * Vocabulary:
 *   - `blocking`  — the requirement has enforcement level MANDATORY and the
 *                   worker fails it. Assignment/reassignment is refused.
 *   - `advisory`  — the requirement has enforcement level RECOMMENDED and the
 *                   worker fails it. Reported only; never blocks.
 *   - `reason`    — a machine-readable gap cause. This is the difference
 *                   between "we cannot tell you" and "this certificate is
 *                   unverified" that Operations needs on screen.
 *
 * Nothing in this module writes: eligibility never mutates a worker, a
 * certificate or an assignment.
 */
import type { CompetencyEnforcementLevel } from '../service-competency-requirements';
import type { ProficiencyLevel } from '../workforce-skills';

export const COMPETENCY_GAP_REASONS = [
  'SKILL_MISSING',
  'PROFICIENCY_INSUFFICIENT',
  'CERTIFICATION_MISSING',
  'CERTIFICATION_UNVERIFIED',
  'CERTIFICATION_EXPIRED',
  'CERTIFICATION_INACTIVE',
] as const;

export type CompetencyGapReason = (typeof COMPETENCY_GAP_REASONS)[number];

/** Evidence attached to a satisfied requirement. */
export type CompetencyEvidence = {
  /** SKILL requirements. */
  proficiencyLevel: ProficiencyLevel | null;
  /** CERTIFICATION requirements. */
  certificationId: string | null;
  certificateNumber: string | null;
  certificateName: string | null;
  issuingAuthority: string | null;
  verificationStatus: string | null;
  issueDate: string | null;
  expiryDate: string | null;
};

/**
 * Near-miss evidence for a FAILED certification requirement: what the worker
 * actually holds, so Operations can tell "never certified" apart from
 * "certificate expired last month" without opening another screen.
 */
export type CompetencyGapEvidence = {
  /** Best-effort: the closest matching certificate the worker holds. */
  certificationId: string | null;
  certificateNumber: string | null;
  verificationStatus: string | null;
  status: string | null;
  expiryDate: string | null;
  /** SKILL requirements: the level the worker actually holds (if any). */
  proficiencyLevel: ProficiencyLevel | null;
};

export type CompetencyRequirementEvaluation = {
  requirementId: string;
  requirementType: 'SKILL' | 'CERTIFICATION';
  enforcementLevel: CompetencyEnforcementLevel;
  skillId: string | null;
  skillCode: string | null;
  skillName: string | null;
  minimumProficiencyLevel: ProficiencyLevel | null;
  certificateName: string | null;
  satisfied: boolean;
  /** Null when satisfied. */
  reason: CompetencyGapReason | null;
  evidence: CompetencyEvidence | null;
  gapEvidence: CompetencyGapEvidence | null;
};

export type WorkerCompetencyEligibility = {
  workerContextId: string;
  workforceProfileId: string;
  workforceProfileName: string | null;
  isLead: boolean;
  eligible: boolean;
  blockingGaps: CompetencyRequirementEvaluation[];
  advisoryGaps: CompetencyRequirementEvaluation[];
  satisfiedCount: number;
  requirementsEvaluated: number;
};

export type CompetencyEvaluationSummary = {
  requirementCount: number;
  mandatoryRequirementCount: number;
  recommendedRequirementCount: number;
  /** True when the job type has no ACTIVE requirement at all. */
  requirementsConfigured: boolean;
};

/** Eligibility report for one EXISTING crew (assignment preflight). */
export type CrewCompetencyEligibilityReport = {
  executionScopeId: string;
  serviceCatalogId: string;
  serviceCatalogCode: string;
  crewId: string;
  summary: CompetencyEvaluationSummary;
  eligible: boolean;
  /** Union of the members' MANDATORY gaps (one row per requirement+reason). */
  blockingGaps: CompetencyRequirementEvaluation[];
  /** Union of the members' RECOMMENDED gaps. Never blocks. */
  advisoryGaps: CompetencyRequirementEvaluation[];
  workers: WorkerCompetencyEligibility[];
};

/**
 * Candidate row for the "who can take this job" read model. Competency is the
 * only dimension evaluated here; registration/building placement keeps being
 * enforced by the assignment authority itself.
 */
export type CompetencyCandidateCrew = {
  crewId: string;
  crewCode: string;
  crewName: string;
  providerContextId: string;
  providerContextStatus: string;
  competencyEligible: boolean;
  blockingGaps: CompetencyRequirementEvaluation[];
  advisoryGaps: CompetencyRequirementEvaluation[];
  workers: WorkerCompetencyEligibility[];
};

export type CompetencyCandidateReport = {
  executionScopeId: string;
  serviceCatalogId: string;
  serviceCatalogCode: string;
  summary: CompetencyEvaluationSummary;
  candidates: CompetencyCandidateCrew[];
  eligibleCandidateCount: number;
};

/** Internal row shapes used by the repository. */
export type ScopeJobTypeRow = {
  executionScopeId: string;
  clientId: string;
  buildingId: string;
  serviceCatalogId: string;
  serviceCatalogCode: string;
  serviceCatalogStatus: string;
};

export type CrewWorkerRow = {
  crewId: string;
  workerContextId: string;
  workforceProfileId: string;
  workforceProfileName: string | null;
  isLead: boolean;
};

export type WorkerSkillRow = {
  workforceProfileId: string;
  skillId: string;
  proficiencyLevel: ProficiencyLevel;
};

export type WorkerCertificationRow = {
  id: string;
  workforceProfileId: string;
  skillId: string | null;
  certificateNumber: string;
  certificateName: string;
  issuingAuthority: string;
  issueDate: Date | string;
  expiryDate: Date | string | null;
  status: string;
  verificationStatus: string;
};

export type CandidateCrewRow = {
  crewId: string;
  crewCode: string;
  crewName: string;
  providerContextId: string;
  providerContextStatus: string;
};
