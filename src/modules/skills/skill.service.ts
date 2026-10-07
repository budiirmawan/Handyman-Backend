import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { skillCodeAlreadyExistsError, skillNotFoundError } from './skill.errors';
import { skillRepository } from './skill.repository';
import { normalizeSkillCode } from './skill.validation';
import type {
  CreateSkillInput,
  NewSkill,
  PublicSkill,
  SkillRecord,
} from './skill.types';

export function toPublicSkill(record: SkillRecord): PublicSkill {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    description: record.description,
    category: record.category,
    status: record.status,
  };
}

/**
 * Validates the owning Client, then creates the Skill.
 *
 * Order matters: an unknown Client is a 404 and an INACTIVE Client is a 400,
 * both resolved before any uniqueness work, so a caller can never probe the
 * catalog of a Client that does not exist or is not operating.
 */
export async function createSkill(input: CreateSkillInput): Promise<PublicSkill> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const code = normalizeSkillCode(input.code);

  const existing = await skillRepository.findByCodeForClient(input.clientId, code);
  if (existing) {
    throw skillCodeAlreadyExistsError();
  }

  const newSkill: NewSkill = {
    clientId: input.clientId,
    code,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    category: input.category ?? 'TECHNICAL',
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await skillRepository.create(newSkill);
    return toPublicSkill(record);
  } catch (error) {
    // The (client_id, code) unique index is the final authority: it also covers
    // the race between the pre-check above and the INSERT.
    if (isSkillCodeUniqueViolation(error)) {
      throw skillCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getSkillById(id: string): Promise<PublicSkill> {
  const record = await skillRepository.findById(id);
  if (!record) {
    throw skillNotFoundError();
  }
  return toPublicSkill(record);
}

/**
 * Lists the Skill catalog of one Client.
 *
 * The Client is validated first (unknown Client → 404 rather than an empty
 * list) and the query itself is scoped to `client_id`, so Client B's catalog is
 * never reachable through Client A's route.
 */
export async function listSkillsByClient(clientId: string): Promise<PublicSkill[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }

  const records = await skillRepository.listByClient(clientId);
  return records.map(toPublicSkill);
}

function isSkillCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' && candidate.constraint === 'skills_client_code_unique'
  );
}

export const skillService = {
  createSkill,
  getSkillById,
  listSkillsByClient,
};
