import{AppError,ERROR_CODES}from'../../shared/errors';
const error=(code:keyof typeof ERROR_CODES,message:string,statusCode:number)=>new AppError({code:ERROR_CODES[code],message,statusCode});
export const paymentReceiptNotFoundError=()=>error('PAYMENT_RECEIPT_NOT_FOUND','Payment Receipt not found.',404);
export const paymentReceiptContextInvalidError=()=>error('PAYMENT_RECEIPT_CONTEXT_INVALID','A valid finalized Invoice with recorded paid amount is required.',400);
export const paymentReceiptAmountInvalidError=()=>error('PAYMENT_RECEIPT_AMOUNT_INVALID','Receipt amount must be positive and covered by the recorded paid amount.',400);
export const paymentReceiptDuplicateReferenceError=()=>error('PAYMENT_RECEIPT_REFERENCE_ALREADY_EXISTS','A Receipt already uses this payment reference for the Client.',409);
export const paymentReceiptNumberExistsError=()=>error('PAYMENT_RECEIPT_NUMBER_ALREADY_EXISTS','Receipt number already exists for the Client.',409);
export const paymentReceiptAlreadyVoidError=()=>error('PAYMENT_RECEIPT_ALREADY_VOID','The Receipt is already void and cannot be changed.',400);
