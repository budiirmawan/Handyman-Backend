export const PAYMENT_RECEIPT_STATUSES = ['ISSUED','VOID'] as const;
export type PaymentReceiptStatus = (typeof PAYMENT_RECEIPT_STATUSES)[number];
export const isPaymentReceiptStatus = (value:unknown):value is PaymentReceiptStatus =>
  typeof value==='string'&&(PAYMENT_RECEIPT_STATUSES as readonly string[]).includes(value);
export type PaymentReceiptRecord = {
  id:string;receiptNumber:string;invoiceId:string;invoicePaymentStatusId:string;
  clientId:string;tenantCompanyId:string;buildingId:string;receivedAmount:string;
  receivedAt:Date;paymentReference:string|null;paymentMethod:string|null;
  status:PaymentReceiptStatus;notes:string|null;issuedByUserId:string;
  voidedAt:Date|null;voidedByUserId:string|null;createdAt:Date;updatedAt:Date;
};
export type PublicPaymentReceipt = Omit<PaymentReceiptRecord,
  'receivedAmount'|'receivedAt'|'voidedAt'|'createdAt'|'updatedAt'> & {
  receivedAmount:number;receivedAt:string;voidedAt:string|null;createdAt:string;updatedAt:string;
};
export type IssuePaymentReceiptInput = {
  invoiceId:string;receiptNumber:string;receivedAmount:number;receivedAt:Date;
  paymentReference?:string|null;paymentMethod?:string|null;notes?:string|null;
};
export type NewPaymentReceipt = {
  receiptNumber:string;invoiceId:string;invoicePaymentStatusId:string;
  clientId:string;tenantCompanyId:string;buildingId:string;receivedAmount:number;
  receivedAt:Date;paymentReference:string|null;paymentMethod:string|null;
  notes:string|null;issuedByUserId:string;
};
export type PaymentReceiptFilters = {
  tenantCompanyId?:string;invoiceId?:string;buildingId?:string;
  status?:PaymentReceiptStatus;receivedFrom?:Date;receivedTo?:Date;
};
