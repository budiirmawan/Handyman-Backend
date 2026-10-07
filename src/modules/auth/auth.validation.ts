import { AppError } from '../../shared/errors';
import { isValidEmail } from '../users';

export type LoginBody = {
  email: string;
  password: string;
};

/**
 * Parses and validates the `POST /auth/login` body. Deliberately does not
 * apply the password policy: login accepts whatever was stored, and policy is
 * only enforced at password set/change time.
 */
export function parseLoginBody(body: unknown): LoginBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const source = body as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];

  const email = typeof source.email === 'string' ? source.email.trim() : '';
  const password = typeof source.password === 'string' ? source.password : '';

  if (email === '' || !isValidEmail(email)) {
    details.push({
      field: 'email',
      message: 'Email is required and must be a valid email address.',
    });
  }

  if (password === '') {
    details.push({ field: 'password', message: 'Password is required.' });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { email, password };
}
