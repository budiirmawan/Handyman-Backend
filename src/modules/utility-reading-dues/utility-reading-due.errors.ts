import { AppError, ERROR_CODES } from '../../shared/errors';
const e=(code:keyof typeof ERROR_CODES,message:string,statusCode:number)=>new AppError({code:ERROR_CODES[code],message,statusCode});
export const utilityReadingDueNotFoundError=()=>e('UTILITY_READING_DUE_NOT_FOUND','Utility Reading Due not found.',404);
export const utilityReadingDueDuplicateError=()=>e('UTILITY_READING_DUE_ALREADY_EXISTS','A Reading Due already exists for this Meter and period.',409);
export const utilityReadingDueInvalidScheduleError=()=>e('UTILITY_READING_DUE_SCHEDULE_INVALID','The schedule/task does not target this Utility Meter and Building.',400);
export const utilityReadingDueTransitionError=()=>e('UTILITY_READING_DUE_TRANSITION_INVALID','The Reading Due lifecycle transition is not allowed.',409);
export const utilityReadingDueReadingMismatchError=()=>e('UTILITY_READING_DUE_READING_MISMATCH','The authoritative Meter Reading does not match this Meter or reading period.',400);
