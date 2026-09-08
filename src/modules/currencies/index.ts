import { getPool } from '../../database';
export type CurrencyStatus='ACTIVE'|'INACTIVE'; export type Currency={code:string;name:string;numericCode:string|null;decimalPrecision:number;status:CurrencyStatus;createdAt:Date;updatedAt:Date};
const select=`code,name,numeric_code AS "numericCode",decimal_precision AS "decimalPrecision",status,created_at AS "createdAt",updated_at AS "updatedAt"`;
export const currencyRepository={
 async list(){return (await getPool().query<Currency>(`SELECT ${select} FROM currencies ORDER BY code`)).rows;},
 async find(code:string){return (await getPool().query<Currency>(`SELECT ${select} FROM currencies WHERE code=$1`,[code])).rows[0]??null;},
 async updateStatus(code:string,status:CurrencyStatus){return (await getPool().query<Currency>(`UPDATE currencies SET status=$2,updated_at=NOW() WHERE code=$1 RETURNING ${select}`,[code,status])).rows[0]??null;}
};
export const currencyService={
 async listCurrencies(){return currencyRepository.list();},
 async setCurrencyStatus(code:string,status:CurrencyStatus,_actorUserId:string){const currency=await currencyRepository.updateStatus(code,status);if(!currency)throw Object.assign(new Error('Currency not found'),{statusCode:404,code:'CURRENCY_NOT_FOUND'});return currency;}
};
