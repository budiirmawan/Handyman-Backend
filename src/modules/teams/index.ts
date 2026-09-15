export {
  teamCodeAlreadyExistsError,
  teamInactiveError,
  teamNotFoundError,
} from './team.errors';

export { teamRepository } from './team.repository';

export {
  teamService,
  createTeam,
  getTeamById,
  listTeamsByDepartment,
  toPublicTeam,
  updateTeam,
} from './team.service';

export { TEAM_STATUSES, isTeamStatus } from './team.types';

export {
  isValidTeamCode,
  isValidUuid,
  normalizeTeamCode,
  parseCreateTeamBody,
  parseDepartmentIdParam,
  parseTeamIdParam,
  parseUpdateTeamBody,
} from './team.validation';

export type { CreateTeamBody, UpdateTeamBody } from './team.validation';

export type {
  CreateTeamInput,
  NewTeam,
  PublicTeam,
  TeamRecord,
  TeamStatus,
  UpdateTeamInput,
} from './team.types';
