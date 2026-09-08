import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: keyof typeof ERROR_CODES,
  message: string,
  statusCode: number,
): AppError => new AppError({ code: ERROR_CODES[code], message, statusCode });

export const operationalBudgetNotFoundError = (): AppError =>
  error('OPERATIONAL_BUDGET_NOT_FOUND', 'Operational Budget not found.', 404);

export const operationalBudgetPeriodConflictError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_PERIOD_CONFLICT',
    'A live Operational Budget period already exists for this Building.',
    409,
  );

export const operationalBudgetNotDraftError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_NOT_DRAFT',
    'Only a draft Operational Budget can be changed.',
    400,
  );

export const operationalBudgetTransitionInvalidError = (
  from: string,
  to: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.OPERATIONAL_BUDGET_TRANSITION_INVALID,
    message: `An Operational Budget cannot move from ${from} to ${to}.`,
    statusCode: 409,
    details: [{ field: 'status', message: `current status is ${from}` }],
  });

export const operationalBudgetCategoryNotFoundError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_CATEGORY_NOT_FOUND',
    'Operational Budget Category not found.',
    404,
  );

export const operationalBudgetCategoryCodeExistsError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_CATEGORY_CODE_ALREADY_EXISTS',
    'This category code already exists for the Operational Budget.',
    409,
  );

export const operationalBudgetCategoryNotDraftError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_CATEGORY_NOT_DRAFT',
    'Categories can only be changed while the Operational Budget is draft.',
    400,
  );

export const operationalBudgetCategoryTotalExceedsError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_CATEGORY_TOTAL_EXCEEDS_BUDGET',
    'The category planned-amount total cannot exceed the budget planned amount.',
    400,
  );

export const operationalBudgetCategoryTotalMismatchError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_CATEGORY_TOTAL_MISMATCH',
    'An Operational Budget can only become active when category planned amounts exactly equal the budget planned amount.',
    400,
  );

export const operationalBudgetSourceBindingNotFoundError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_BINDING_NOT_FOUND',
    'Operational Budget source binding not found.',
    404,
  );

export const operationalBudgetSourceBindingNotActiveError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_BINDING_NOT_ACTIVE',
    'Only an active source binding can be removed.',
    400,
  );

export const operationalBudgetSourceNotFoundError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_NOT_FOUND',
    'The referenced operational cost source was not found.',
    404,
  );

export const operationalBudgetSourceNotEligibleError = (
  reason = 'The referenced operational cost source is not eligible for Building operational finance.',
): AppError => error('OPERATIONAL_BUDGET_SOURCE_NOT_ELIGIBLE', reason, 400);

export const operationalBudgetSourceContextInvalidError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_CONTEXT_INVALID',
    'The operational cost source context is inconsistent.',
    400,
  );

export const operationalBudgetSourceCategoryMismatchError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_CATEGORY_MISMATCH',
    'The budget category does not belong to the requested Operational Budget.',
    400,
  );

export const operationalBudgetSourceCurrencyMismatchError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_CURRENCY_MISMATCH',
    'The operational cost source currency does not match the budget currency.',
    400,
  );

export const operationalBudgetSourceAlreadyBoundError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_ALREADY_BOUND',
    'This operational cost source is already actively bound to Operational Finance.',
    409,
  );

export const operationalBudgetSourceLineageDuplicateError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_LINEAGE_DUPLICATE',
    'The source is already represented by another actively bound authoritative cost record.',
    409,
  );

export const operationalBudgetSourceLineageAmbiguousError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_LINEAGE_AMBIGUOUS',
    'The source lineage is ambiguous with another actively bound cost record.',
    409,
  );

export const operationalBudgetSourceBindingBudgetNotOpenError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_SOURCE_BINDING_BUDGET_NOT_OPEN',
    'Source bindings can only be added or removed for draft or active budgets.',
    400,
  );

export const operationalBudgetCategoryHasSourceBindingsError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_CATEGORY_HAS_SOURCE_BINDINGS',
    'A budget category with source lineage cannot be deleted.',
    409,
  );
