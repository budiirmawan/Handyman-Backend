import { AppError, ERROR_CODES } from '../../shared/errors';
const e=(code:keyof typeof ERROR_CODES,message:string,statusCode:number)=>new AppError({code:ERROR_CODES[code],message,statusCode});
export const utilityReadingDueNotFoundError=()=>e('UTILITY_READING_DUE_NOT_FOUND','Utility Reading Due not found.',404);
export const utilityReadingDueDuplicateError=()=>e('UTILITY_READING_DUE_ALREADY_EXISTS','A Reading Due already exists for this Meter and period.',409);
export const utilityReadingDueInvalidScheduleError=()=>e('UTILITY_READING_DUE_SCHEDULE_INVALID','The schedule/task does not target this Utility Meter and Building.',400);
export const utilityReadingDueTransitionError=()=>e('UTILITY_READING_DUE_TRANSITION_INVALID','The Reading Due lifecycle transition is not allowed.',409);
export const utilityReadingDueReadingMismatchError=()=>e('UTILITY_READING_DUE_READING_MISMATCH','The authoritative Meter Reading does not match this Meter or reading period.',400);

/**
 * CR-BE-RN12-METER-FIELD-01 PART 00 — field-actor authority errors.
 *
 * All three are DENIALS. None of them widens authority: a Reading Due that
 * cannot prove a field actor through the existing generated-task /
 * task-assignment chain is simply not field-accessible, and the caller must
 * not be offered `utility_meter.manage`, a role name, or Building access as a
 * substitute.
 */

/**
 * The Reading Due carries no `generated_task_id`, so there is no task
 * assignment to prove field authority against. This is a configuration state,
 * not an actor fault — 403 so a mobile client cannot distinguish it from an
 * unauthorized actor by status alone, but the code says exactly which it was.
 */
export const utilityReadingDueNoFieldTaskError = () =>
  e(
    'UTILITY_READING_DUE_NO_FIELD_TASK',
    'This Reading Due has no generated task, so field authority cannot be established.',
    403,
  );

/** The actor is not the assignee of the Reading Due's generated task. */
export const utilityReadingDueFieldUnauthorizedError = () =>
  e(
    'UTILITY_READING_DUE_FIELD_UNAUTHORIZED',
    'The acting user is not authorized for this Reading Due task assignment.',
    403,
  );

/**
 * The generated task no longer targets this Meter / Building / Client.
 * `createUtilityReadingDue` asserts this invariant on write; re-asserting it on
 * read means a later re-pointed or re-targeted task cannot be used to reach a
 * Meter it was never issued for.
 */
export const utilityReadingDueFieldTaskMismatchError = () =>
  e(
    'UTILITY_READING_DUE_FIELD_TASK_MISMATCH',
    'The generated task does not target this Utility Meter and Building.',
    403,
  );

