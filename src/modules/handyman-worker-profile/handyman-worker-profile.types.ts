import type { SkillCategory } from '../skills';
import type { WorkforceCertificationMobileSummary } from '../workforce-certifications/workforce-certification.types';
import type { ProficiencyLevel } from '../workforce-skills/workforce-skill.types';

export type HandymanWorkerAuthorizedRole =
  | 'PIC_PEKERJAAN'
  | 'CREW_MEMBER'
  | 'INSPECTOR';

export interface HandymanWorkerProfileProjection {
  workerIdentity: {
    userId: string;
    workforceProfileId: string;
    workerContextId: string;
    workerCode: string;
    employeeCode: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    workforceType: string;
    employmentType: string;
    workerStatus: string;
  };
  providerAssociation: {
    clientId: string;
    providerContextId: string;
    providerCode: string;
    providerStatus: string;
    vendorId: string;
    vendorStatus: string;
    organizationId: string;
    organizationCode: string;
    organizationName: string;
    bindingStatus: string | null;
    bindingEffectiveFrom: string | null;
    bindingEffectiveUntil: string | null;
  };
  roleAndAssignmentContext: {
    authorizedRoles: HandymanWorkerAuthorizedRole[];
    crewMemberships: Array<{
      crewId: string;
      crewCode: string;
      crewName: string;
      buildingId: string | null;
      crewStatus: string;
      membershipStatus: string;
      isCrewLead: boolean;
      joinedAt: string;
    }>;
    buildingAssignments: Array<{
      buildingId: string;
      buildingCode: string;
      buildingName: string;
      propertyId: string;
      assignmentRole: string;
      isPrimary: boolean;
      status: string;
      effectiveFrom: string | null;
      effectiveUntil: string | null;
    }>;
  };
  skillsAndCategories: {
    serviceCategories: SkillCategory[];
    effectiveSkills: Array<{
      skillId: string;
      code: string;
      name: string;
      category: SkillCategory;
      proficiencyLevel: ProficiencyLevel;
      validFrom: string | null;
      validUntil: string | null;
    }>;
  };
  certificationsAndExpiry: {
    /**
     * CR-HM-WORKER-COMPETENCY-01 PART 02 — individual per-worker certificate
     * serial numbers ARE now modeled (`workforce_certifications`, migration
     * 0461) and projected in `individualCertifications`. The flag flipped from
     * `false` to `true`; it is additive for consumers, and the three existing
     * fields below keep their exact previous meaning.
     */
    individualCertificateNumberModeled: true;
    individualCertifications: WorkforceCertificationMobileSummary[];
    skillValidityWindows: Array<{
      skillId: string;
      skillCode: string;
      skillName: string;
      proficiencyLevel: ProficiencyLevel;
      validFrom: string | null;
      expiresAt: string | null;
      isExpired: boolean;
    }>;
    providerLicensesAndCertifications: Array<{
      id: string;
      recordType: string;
      name: string;
      number: string;
      issuingAuthority: string | null;
      issueDate: string | null;
      expiryDate: string | null;
      status: string;
    }>;
  };
  workHistorySummary: {
    assignedExecutionScopesCount: number;
    activeWorkSessionsCount: number;
    completedWorkSessionsCount: number;
    activeInspectionsCount: number;
    completedInspectionsCount: number;
    recentWorkOrders: Array<{
      executionScopeId: string;
      handymanRequestId: string;
      requestCode: string;
      title: string;
      buildingId: string;
      scopeStatus: string;
      assignmentStatus: string;
      roleInJob: 'PIC_PEKERJAAN' | 'CREW_MEMBER';
      assignedAt: string;
    }>;
  };
}
