import{Router}from'express';import{authenticationMiddleware}from'../auth/authentication.middleware';import{requirePermission}from'../auth/rbac.middleware';
import{getInvoicePaymentStatusHandler,listInvoicePaymentStatusesHandler,recordInvoicePaymentStatusHandler,updateInvoicePaymentStatusHandler}from'./invoice-payment-status.controller';
/** BE-19E settlement-state tracking only; no gateway, banking, receipt, or accounting. */
export function createInvoicePaymentStatusRouter():Router{const r=Router(),a=authenticationMiddleware,read=requirePermission('invoice_payment_status.read'),manage=requirePermission('invoice_payment_status.manage');
r.post('/tenant-invoices/:invoiceId/payment-status',a,manage,recordInvoicePaymentStatusHandler);
r.get('/tenant-invoices/:invoiceId/payment-status',a,read,getInvoicePaymentStatusHandler);
r.get('/invoice-payment-statuses',a,read,listInvoicePaymentStatusesHandler);
r.patch('/invoice-payment-statuses/:id',a,manage,updateInvoicePaymentStatusHandler);return r;}
