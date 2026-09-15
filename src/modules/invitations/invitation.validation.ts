import { AppError } from '../../shared/errors';
import { isValidEmail } from '../users';
import type { AcceptInvitationInput, CreateInvitationInput } from './invitation.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseCreateInvitationBody(body: unknown): CreateInvitationInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const source = body as Record<string, unknown>;
  const email = typeof source.email === 'string' ? source.email.trim() : '';

  if (email === '' || !isValidEmail(email)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'email', message: 'Email is required and must be a valid email address.' },
    ]);
  }

  return { email };
}

export function parseAcceptInvitationBody(body: unknown): AcceptInvitationInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const source = body as Record<string, unknown>;
  const details: ValidationDetail[] = [];

  const token = typeof source.token === 'string' ? source.token.trim() : '';
  const displayName =
    typeof source.displayName === 'string' ? source.displayName.trim() : '';
  const password = typeof source.password === 'string' ? source.password : '';

  if (token === '') {
    details.push({ field: 'token', message: 'Token is required.' });
  }

  if (displayName === '') {
    details.push({ field: 'displayName', message: 'Display name is required.' });
  }

  if (password === '') {
    details.push({ field: 'password', message: 'Password is required.' });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { token, displayName, password };
}

export function parseInvitationIdParam(raw: string): string {
  const value = raw.trim();
  if (!UUID_PATTERN.test(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Invitation id must be a valid UUID.' },
    ]);
  }

  return value.toLowerCase();
}
