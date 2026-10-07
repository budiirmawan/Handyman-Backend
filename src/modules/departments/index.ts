export {
  departmentCodeAlreadyExistsError,
  departmentInactiveError,
  departmentNotFoundError,
} from './department.errors';

export { departmentRepository } from './department.repository';

export {
  departmentService,
  createDepartment,
  getDepartmentById,
  listDepartmentsByOrganization,
  toPublicDepartment,
  updateDepartment,
} from './department.service';

export {
  DEPARTMENT_STATUSES,
  isDepartmentStatus,
} from './department.types';

export {
  isValidDepartmentCode,
  isValidUuid,
  normalizeDepartmentCode,
  parseCreateDepartmentBody,
  parseOrganizationIdParam,
  parseDepartmentIdParam,
  parseUpdateDepartmentBody,
} from './department.validation';

export type {
  CreateDepartmentInput,
  DepartmentRecord,
  DepartmentStatus,
  NewDepartment,
  PublicDepartment,
  UpdateDepartmentInput,
} from './department.types';

export type { ValidationDetail } from './department.validation';
