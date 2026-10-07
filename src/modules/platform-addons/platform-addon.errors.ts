import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-SAAS-01 PART 13C — Add-on error factories.
 *
 * Discipline (PART 13C #3 / PART 01B #6): only the frozen §17.1 code
 * `SAAS_ADD_ON_NOT_FOUND` is added. All other conflict / duplicate
 * semantics use the canonical generic CONFLICT code so the gap does
 * not pollute the §17.1 vocabulary before contract disposition.
 */
export function saasAddOnNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_ADD_ON_NOT_FOUND,
    message: 'SaaS add-on not found.',
    statusCode: 404,
    resource: { type: 'SAAS_ADD_ON', id },
  });
}
