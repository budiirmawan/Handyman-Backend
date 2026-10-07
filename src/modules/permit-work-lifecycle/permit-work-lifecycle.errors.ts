import { AppError, ERROR_CODES } from '../../shared/errors';
const error=(code:(typeof ERROR_CODES)[keyof typeof ERROR_CODES],message:string,statusCode:number)=>new AppError({code,message,statusCode});
export const permitWorkContextInvalidError=()=>error(ERROR_CODES.PERMIT_WORK_CONTEXT_INVALID,'Permit Work context is invalid.',400);
export const permitWorkNotReadyError=(blockers:string[])=>new AppError({code:ERROR_CODES.PERMIT_WORK_NOT_READY,message:'Permit Work Start prerequisites are not ready.',statusCode:400,details:blockers.map((blocker)=>({blocker}))});
export const permitWorkAlreadyStartedError=()=>error(ERROR_CODES.PERMIT_WORK_ALREADY_STARTED,'Permit Work has already started.',409);
export const permitWorkCloseBeforeStartError=()=>error(ERROR_CODES.PERMIT_WORK_CLOSE_BEFORE_START,'Permit Work cannot close before it starts.',400);
export const permitWorkAlreadyClosedError=()=>error(ERROR_CODES.PERMIT_WORK_ALREADY_CLOSED,'Permit Work is already closed.',409);
export const permitWorkActionNotAllowedError=(action:string)=>error(ERROR_CODES.PERMIT_WORK_ACTION_NOT_ALLOWED,`Permit Work action ${action} is not allowed.`,403);
