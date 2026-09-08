import {
  managementOperationsCommandCenterService,
  parseManagementOperationsCommandCenterQuery,
} from '../management-operations-command-center';
import {
  parseFindingIncidentKpiQuery,
  securityFindingIncidentKpiService,
} from '../security-finding-incident-kpi';
import {
  parsePatrolKpiQuery,
  securityPatrolKpiService,
} from '../security-patrol-kpi';
import { parseUtilityKpiQuery, utilityKpiService } from '../utility-kpi';
import {
  parseVendorTenantKpiQuery,
  vendorTenantKpiService,
} from '../vendor-tenant-kpi';
import { parseWorkforceKpiQuery, workforceKpiService } from '../workforce-kpi';
import {
  projectSecurityFindingIncident,
  projectSecurityPatrol,
  projectUtility,
  projectVendorTenant,
  projectWorkforce,
} from './reporting-export.projections';
import { projectManagementOperationsCommandCenter } from './reporting-export.management-projections';
import { AppError } from '../../shared/errors';
import {
  REPORTING_EXPORT_DATASETS,
  isReportingExportDataset,
  type ReportingExportDataset,
  type ReportingExportKpiValue,
  type ReportingExportTable,
} from './reporting-export.types';

/**
 * CR-BE-EXP-01 PART 05 — governed dataset registry.
 *
 * Each adapter delegates filtering and calculation to the read-model/KPI
 * authority that already owns it, then returns the same neutral projection
 * consumed by every format renderer. This registry does not query source
 * tables, calculate KPIs, or create a second reporting authority.
 */

type CommonExportEnvelope = {
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
};

export type ReportingExportProjection = {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
};

export type ReportingExportAdapterResult = {
  common: CommonExportEnvelope;
  projected: ReportingExportProjection;
  appliedFilters: Record<string, string | number | boolean | null>;
};

export type ReportingExportDatasetAdapter = {
  dataset: ReportingExportDataset;
  datasetLabel: string;
  sourceAuthority: string;
  requiredReadPermission: string;
  load: (
    passThrough: Record<string, unknown>,
    userId: string,
  ) => Promise<ReportingExportAdapterResult>;
};

function echoFilters(
  parsed: Record<string, unknown>,
  extra: Record<string, string | number | boolean | null> = {},
): Record<string, string | number | boolean | null> {
  const filters: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      filters[key] = value;
    }
  }
  return { ...filters, ...extra };
}

export const REPORTING_EXPORT_DATASET_REGISTRY: Readonly<
  Record<ReportingExportDataset, ReportingExportDatasetAdapter>
> = {
  SECURITY_PATROL: {
    dataset: 'SECURITY_PATROL',
    datasetLabel: 'Security Patrol & Activity',
    sourceAuthority: 'BE-23F1 security-patrol-kpi',
    requiredReadPermission: 'security_patrol_kpi.read',
    async load(passThrough, userId) {
      const filters = parsePatrolKpiQuery(passThrough);
      const source = await securityPatrolKpiService.getSecurityPatrolKpi(
        filters,
        userId,
      );
      return {
        common: source,
        projected: projectSecurityPatrol(source),
        appliedFilters: echoFilters(filters, {
          graceMinutes: source.graceMinutes,
        }),
      };
    },
  },
  SECURITY_FINDING_INCIDENT: {
    dataset: 'SECURITY_FINDING_INCIDENT',
    datasetLabel: 'Security Finding / Incident / Handover',
    sourceAuthority: 'BE-23F2 security-finding-incident-kpi',
    requiredReadPermission: 'security_finding_incident_kpi.read',
    async load(passThrough, userId) {
      const filters = parseFindingIncidentKpiQuery(passThrough);
      const source =
        await securityFindingIncidentKpiService.getSecurityFindingIncidentKpi(
          filters,
          userId,
        );
      return {
        common: source,
        projected: projectSecurityFindingIncident(source),
        appliedFilters: echoFilters(filters),
      };
    },
  },
  WORKFORCE: {
    dataset: 'WORKFORCE',
    datasetLabel: 'Workforce',
    sourceAuthority: 'BE-23G workforce-kpi',
    requiredReadPermission: 'workforce_kpi.read',
    async load(passThrough, userId) {
      const filters = parseWorkforceKpiQuery(passThrough);
      const source = await workforceKpiService.getWorkforceKpi(filters, userId);
      return {
        common: source,
        projected: projectWorkforce(source),
        appliedFilters: echoFilters(filters, {
          graceMinutes: source.graceMinutes,
        }),
      };
    },
  },
  VENDOR_TENANT: {
    dataset: 'VENDOR_TENANT',
    datasetLabel: 'Vendor / Tenant',
    sourceAuthority: 'BE-23H vendor-tenant-kpi',
    requiredReadPermission: 'vendor_tenant_kpi.read',
    async load(passThrough, userId) {
      const filters = parseVendorTenantKpiQuery(passThrough);
      const source = await vendorTenantKpiService.getVendorTenantKpi(
        filters,
        userId,
      );
      return {
        common: source,
        projected: projectVendorTenant(source),
        appliedFilters: echoFilters(filters, {
          overdueAfterDays: source.overdueAfterDays,
        }),
      };
    },
  },
  UTILITY: {
    dataset: 'UTILITY',
    datasetLabel: 'Utility',
    sourceAuthority: 'BE-23I utility-kpi',
    requiredReadPermission: 'utility_kpi.read',
    async load(passThrough, userId) {
      const filters = parseUtilityKpiQuery(passThrough);
      const source = await utilityKpiService.getUtilityKpi(filters, userId);
      return {
        common: source,
        projected: projectUtility(source),
        appliedFilters: echoFilters(filters, {
          interval: source.interval,
          meterScope: source.meterScope,
          utilityType: source.utilityType,
        }),
      };
    },
  },
  MANAGEMENT_OPERATIONS_COMMAND_CENTER: {
    dataset: 'MANAGEMENT_OPERATIONS_COMMAND_CENTER',
    datasetLabel: 'Management Operations Command Center',
    sourceAuthority: 'BE-24 management-operations-command-center',
    requiredReadPermission: 'management_read_model.read',
    async load(passThrough, userId) {
      const filters = parseManagementOperationsCommandCenterQuery(passThrough);
      const source =
        await managementOperationsCommandCenterService.getManagementOperationsCommandCenter(
          filters,
          userId,
        );
      const projected = projectManagementOperationsCommandCenter(source);
      return {
        common: {
          buildingId:
            source.scope.buildingIds.length === 1
              ? source.scope.buildingIds[0]!
              : null,
          buildingScope: source.scope.buildingIds,
          dateFrom: source.period.dateFrom,
          dateTo: source.period.dateTo,
          asOf: source.asOf,
        },
        projected,
        appliedFilters: echoFilters({ ...source.filters }),
      };
    },
  },
};

export function getReportingExportDatasetAdapter(
  dataset: unknown,
): ReportingExportDatasetAdapter {
  if (!isReportingExportDataset(dataset)) {
    throw AppError.badRequest(
      `dataset must be one of: ${REPORTING_EXPORT_DATASETS.join(', ')}.`,
    );
  }
  return REPORTING_EXPORT_DATASET_REGISTRY[dataset];
}
