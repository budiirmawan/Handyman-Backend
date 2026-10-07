export {
  skillCodeAlreadyExistsError,
  skillNotFoundError,
} from './skill.errors';

export { skillRepository } from './skill.repository';

export {
  createSkill,
  getSkillById,
  listSkillsByClient,
  skillService,
  toPublicSkill,
} from './skill.service';

export {
  SKILL_CATEGORIES,
  SKILL_STATUSES,
  isSkillCategory,
  isSkillStatus,
} from './skill.types';

export {
  isValidSkillCode,
  normalizeSkillCode,
  parseCreateSkillBody,
  parseSkillClientIdParam,
  parseSkillIdParam,
} from './skill.validation';

export type {
  CreateSkillInput,
  NewSkill,
  PublicSkill,
  SkillCategory,
  SkillRecord,
  SkillStatus,
} from './skill.types';

export type { ValidationDetail } from './skill.validation';
