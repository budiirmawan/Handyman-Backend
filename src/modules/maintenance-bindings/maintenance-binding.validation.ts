import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isMaintenanceBindingStatus,
  isMaintenanceType,
  type CreateMaintenanceBindingInput,
  type LinkMaintenanceScheduleInput,
  type LinkMaintenanceTaskInput,
  type LinkMaintenanceWorkOrderInput,
  type MaintenanceBindingStatus,
  type MaintenanceType,
  type UpdateMaintenanceBindingInput,
} from './maintenance-binding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const SCHEDULE_TARGET_TYPES = [
  'FORM_TEMPLATE',
  'FORM_VERSION',
  'CHECKLIST_TEMPLATE',
] as const;

export function parseAssetIdParam(raw: string): string {
  return parseUuidParam(raw, 'assetId', 'Asset id');
}

export function parseBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseBindingIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Maintenance binding id');
}

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateMaintenanceBindingBody(
  body: Record<string, unknown>,
): Pick<
  CreateMaintenanceBindingInput,
  'name' | 'maintenanceType' | 'description' | 'functionalLocationId' | 'status'
> {
  const details: ValidationDetail[] = [];

  const name = readRequiredText(body.name, 'name', 160, details);
  let maintenanceType: MaintenanceType | undefined;
  const rawType = readSingleParam(body.maintenanceType);
  if (rawType === undefined || rawType === '') {
    details.push({ field: 'maintenanceType', message: 'maintenanceType is required.' });
  } else if (!isMaintenanceType(rawType.trim().toUpperCase())) {
    details.push({
      field: 'maintenanceType',
      message: 'maintenanceType is not a supported maintenance type.',
    });
  } else {
    maintenanceType = rawType.trim().toUpperCase() as MaintenanceType;
  }

  const description = readOptionalText(body.description, 'description', 2048, details);
  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );
  const status = readOptionalStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    name: name as string,
    maintenanceType: maintenanceType as MaintenanceType,
    ...(description === undefined ? {} : { description }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateMaintenanceBindingBody(
  body: Record<string, unknown>,
): UpdateMaintenanceBindingInput {
  const details: ValidationDetail[] = [];
  const input: UpdateMaintenanceBindingInput = {};

  const name = readOptionalText(body.name, 'name', 160, details);
  if (name !== undefined) {
    input.name = name;
  }

  const rawType = readSingleParam(body.maintenanceType);
  if (rawType !== undefined && rawType !== '') {
    if (!isMaintenanceType(rawType.trim().toUpperCase())) {
      details.push({
        field: 'maintenanceType',
        message: 'maintenanceType is not a supported maintenance type.',
      });
    } else {
      input.maintenanceType = rawType.trim().toUpperCase() as MaintenanceType;
    }
  }

  if (body.description !== undefined) {
    if (body.description === null) {
      input.description = null;
    } else {
      const description = readOptionalText(body.description, 'description', 2048, details);
      if (description !== undefined) {
        input.description = description;
      }
    }
  }

  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );
  if (functionalLocationId !== undefined) {
    input.functionalLocationId = functionalLocationId;
  }

  const status = readOptionalStatus(body.status, details);
  if (status !== undefined) {
    input.status = status;
  }

  if (Object.keys(input).length === 0) {
    details.push({ field: 'body', message: 'At least one updatable field is required.' });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return input;
}

export function parseLinkMaintenanceScheduleBody(
  body: Record<string, unknown>,
): LinkMaintenanceScheduleInput {
  const details: ValidationDetail[] = [];

  const scheduleDefinitionId = readOptionalUuid(
    body.scheduleDefinitionId,
    'scheduleDefinitionId',
    'Schedule definition id',
    details,
  );
  const targetTypeRaw = readSingleParam(body.targetType);
  let targetType: string | undefined;
  if (targetTypeRaw !== undefined && targetTypeRaw !== '') {
    const normalized = targetTypeRaw.trim().toUpperCase();
    if (!(SCHEDULE_TARGET_TYPES as readonly string[]).includes(normalized)) {
      details.push({
        field: 'targetType',
        message: `targetType must be one of: ${SCHEDULE_TARGET_TYPES.join(', ')}.`,
      });
    } else {
      targetType = normalized;
    }
  }
  const targetId = readOptionalUuid(body.targetId, 'targetId', 'Target id', details);
  const code = readOptionalText(body.code, 'code', 64, details);
  const name = readOptionalText(body.name, 'name', 160, details);
  const startAt = readOptionalIsoDate(body.startAt, 'startAt', details);
  const timezoneRaw = readSingleParam(body.timezone);
  let timezone: string | undefined;
  if (timezoneRaw !== undefined && timezoneRaw !== '') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezoneRaw.trim() });
      timezone = timezoneRaw.trim();
    } catch {
      details.push({ field: 'timezone', message: 'timezone must be a valid IANA timezone.' });
    }
  }

  if (scheduleDefinitionId === undefined) {
    for (const [field, value] of [
      ['targetType', targetType],
      ['targetId', targetId],
      ['name', name],
      ['startAt', startAt],
      ['timezone', timezone],
    ] as const) {
      if (value === undefined) {
        details.push({ field, message: `${field} is required when creating a new schedule.` });
      }
    }
  } else if (
    targetType !== undefined || targetId !== undefined || code !== undefined ||
    name !== undefined || startAt !== undefined || timezone !== undefined
  ) {
    details.push({
      field: 'body',
      message: 'Provide either scheduleDefinitionId or the fields to create a new schedule, not both.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(scheduleDefinitionId === undefined ? {} : { scheduleDefinitionId }),
    ...(targetType === undefined ? {} : { targetType }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(code === undefined ? {} : { code }),
    ...(name === undefined ? {} : { name }),
    ...(startAt === undefined ? {} : { startAt }),
    ...(timezone === undefined ? {} : { timezone }),
  };
}

export function parseLinkMaintenanceTaskBody(
  body: Record<string, unknown>,
): LinkMaintenanceTaskInput {
  const details: ValidationDetail[] = [];
  const taskId = readOptionalUuid(body.taskId, 'taskId', 'Task id', details);
  if (taskId === undefined) {
    details.push({ field: 'taskId', message: 'taskId is required and must be a valid UUID.' });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { taskId: taskId as string };
}

export function parseLinkMaintenanceWorkOrderBody(
  body: Record<string, unknown>,
): LinkMaintenanceWorkOrderInput {
  const details: ValidationDetail[] = [];
  const workOrderId = readOptionalUuid(body.workOrderId, 'workOrderId', 'Work order id', details);
  const title = readOptionalText(body.title, 'title', 160, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(title === undefined ? {} : { title }),
  };
}

function readRequiredText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw.trim() === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  return readOptionalText(raw, field, max, details);
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const text = raw.trim();
  if (text.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return text;
}

function readOptionalIsoDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 datetime.` });
    return undefined;
  }
  return parsed.toISOString();
}

function readOptionalStatus(
  value: unknown,
  details: ValidationDetail[],
): MaintenanceBindingStatus | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isMaintenanceBindingStatus(raw.trim().toUpperCase())) {
    details.push({
      field: 'status',
      message: 'status must be one of: ACTIVE, INACTIVE.',
    });
    return undefined;
  }
  return raw.trim().toUpperCase() as MaintenanceBindingStatus;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
}

function readOptionalNullableUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readOptionalUuid(value, field, label, details);
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}
