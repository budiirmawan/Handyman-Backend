import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { clientInactiveError,clientNotFoundError,clientRepository } from '../clients';
import { contextAccessService } from '../context-access'; import { buildingAccessDeniedError } from '../context-access/context-access.errors'; import { recordOperationalEvent } from '../operational-events';
export type ClientMonetaryContext={clientId:string;baseCurrencyCode:string;defaultTransactionCurrencyCode:string;allowedCurrencyCodes:string[];createdAt:Date;updatedAt:Date};
async function access(userId:string,clientId:string){if(!(await contextAccessService.canAccessClient(userId,clientId)))throw buildingAccessDeniedError();}
async function get(clientId:string){const h=(await getPool().query<{clientId:string;baseCurrencyCode:string;defaultTransactionCurrencyCode:string;createdAt:Date;updatedAt:Date}>(`SELECT client_id AS "clientId",base_currency_code AS "baseCurrencyCode",default_transaction_currency_code AS "defaultTransactionCurrencyCode",created_at AS "createdAt",updated_at AS "updatedAt" FROM client_monetary_contexts WHERE client_id=$1`,[clientId])).rows[0];if(!h)return null;const a=await getPool().query<{currencyCode:string}>('SELECT currency_code AS "currencyCode" FROM client_allowed_transaction_currencies WHERE client_id=$1 ORDER BY currency_code',[clientId]);return {...h,allowedCurrencyCodes:a.rows.map(x=>x.currencyCode)};}
export const clientMonetaryContextService={
 async getClientMonetaryContext(clientId:string,userId:string){await access(userId,clientId);return get(clientId);},
 async setClientMonetaryContext(input:{clientId:string;baseCurrencyCode:string;defaultTransactionCurrencyCode:string;allowedCurrencyCodes:string[]},userId:string){const c=await clientRepository.findById(input.clientId);if(!c)throw clientNotFoundError();if(c.status!=='ACTIVE')throw clientInactiveError();await access(userId,input.clientId);const allowed=[...new Set(input.allowedCurrencyCodes)];if(!allowed.includes(input.baseCurrencyCode)||!allowed.includes(input.defaultTransactionCurrencyCode))throw Object.assign(new Error('Base and default currencies must be allowed'),{statusCode:400,code:'CLIENT_MONETARY_CONTEXT_CURRENCY_NOT_ALLOWED'});await withTransaction(async tx=>{await tx.query('DELETE FROM client_allowed_transaction_currencies WHERE client_id=$1',[input.clientId]);for(const code of allowed)await tx.query('INSERT INTO client_allowed_transaction_currencies(client_id,currency_code) VALUES($1,$2)',[input.clientId,code]);await tx.query(`INSERT INTO client_monetary_contexts(client_id,base_currency_code,default_transaction_currency_code) VALUES($1,$2,$3) ON CONFLICT(client_id) DO UPDATE SET base_currency_code=EXCLUDED.base_currency_code,default_transaction_currency_code=EXCLUDED.default_transaction_currency_code,updated_at=NOW()`,[input.clientId,input.baseCurrencyCode,input.defaultTransactionCurrencyCode]);await recordOperationalEvent({clientId:input.clientId,eventType:'CLIENT_MONETARY_CONTEXT_SET',entityType:'CLIENT_MONETARY_CONTEXT',entityId:input.clientId,actorUserId:userId,summary:'Client monetary context set',metadata:{baseCurrencyCode:input.baseCurrencyCode,defaultTransactionCurrencyCode:input.defaultTransactionCurrencyCode,allowedCurrencyCodes:allowed}},tx);});return (await get(input.clientId))!;}
};

/** Command-time authority for new/changed transaction currency snapshots. Historical reads intentionally do not call this. */
export async function assertActiveAllowedCurrency(clientId:string,currencyCode:string):Promise<void>{
  const row=(await getPool().query<{active:boolean;allowed:boolean}>(`SELECT EXISTS(SELECT 1 FROM currencies WHERE code=$2 AND status='ACTIVE') AS active, EXISTS(SELECT 1 FROM client_allowed_transaction_currencies WHERE client_id=$1 AND currency_code=$2) AS allowed`,[clientId,currencyCode])).rows[0];
  if(!row?.active) throw Object.assign(new Error('Currency is not active'),{statusCode:400,code:'CURRENCY_INACTIVE_OR_UNKNOWN'});
  if(!row.allowed) throw Object.assign(new Error('Currency is not allowed for client'),{statusCode:400,code:'CLIENT_CURRENCY_NOT_ALLOWED'});
}

/**
 * CR-BE-CUR-02: the identical authority surfaced as a typed AppError so public
 * command paths return the governed 400 contract instead of an unhandled 500.
 * No behavioral difference from assertActiveAllowedCurrency.
 */
export async function assertActiveAllowedCurrencyCommand(clientId:string,currencyCode:string):Promise<void>{
  try{await assertActiveAllowedCurrency(clientId,currencyCode)}catch(e){
    const code=typeof e==='object'&&e!==null&&'code'in e?String((e as{code?:unknown}).code):'';
    const message=e instanceof Error?e.message:'Currency is not usable for this client.';
    throw new AppError({code:code==='CLIENT_CURRENCY_NOT_ALLOWED'?ERROR_CODES.CLIENT_CURRENCY_NOT_ALLOWED:ERROR_CODES.CURRENCY_INACTIVE_OR_UNKNOWN,message,statusCode:400});
  }
}
