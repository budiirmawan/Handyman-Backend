import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { parseRecordInvoicePaymentStatusBody, resolveInvoicePaymentStatus } from '../src/modules/invoice-payment-status';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database:DatabaseConfig|null=null;let pool:Pool|null=null;let token='';let userId='';
const suffix=()=>randomUUID().slice(0,8).toUpperCase();const auth=(v=token)=>({Authorization:`Bearer ${v}`});
before(async()=>{const db=await ensureTestDatabase();if(!db)return;pool=await initDatabase(db);await migrateUp(pool);
 await pool.query(`TRUNCATE invoice_payment_status_history, invoice_payment_status,
 tenant_invoice_history, tenant_invoice_lines, tenant_invoices,
 tenant_charge_history, tenant_charges, tenant_building_contexts,
 tenant_space_relationships, tenant_companies, spaces, rooms, areas, floors,
 buildings, properties, users, roles, permissions, clients CASCADE`);
 const admin=await createAdminUser();token=admin.token;userId=admin.userId;database=db;});
after(async()=>{if(pool)await closePool(pool);pool=null;database=null});
function ready(t:TestContext){if(!database||!pool){t.skip('test database unavailable');return false}return true}
async function fixture(assignedUserId=userId,withToken=token){
 const client=await clientService.createClient({code:`C_${suffix()}`,name:'Owner'});
 const property=await propertyService.createProperty({clientId:client.id,code:`P_${suffix()}`,name:'Property'});
 const building=await buildingService.createBuilding({propertyId:property.id,code:`B_${suffix()}`,name:'Building'});
 await buildingAssignmentService.createAssignment(assignedUserId,{buildingId:building.id});
 await clientMonetaryContextService.setClientMonetaryContext({clientId:client.id,baseCurrencyCode:'IDR',defaultTransactionCurrencyCode:'IDR',allowedCurrencyCodes:['IDR','USD']},assignedUserId);
 const floor=await floorService.createFloor({buildingId:building.id,code:`F_${suffix()}`,name:'Floor',levelNumber:1});
 const area=await areaService.createArea({floorId:floor.id,code:`A_${suffix()}`,name:'Area'});
 const room=await roomService.createRoom({areaId:area.id,code:`R_${suffix()}`,name:'Room'});
 const space=await spaceService.createSpace({roomId:room.id,code:`S_${suffix()}`,name:'Space'});
 const tr=await api().post(`/api/v1/clients/${client.id}/tenant-companies`).set(auth(withToken)).send({tenantCode:`TNT_${suffix()}`,tenantName:'Tenant'});
 assert.equal(tr.status,201,JSON.stringify(tr.body));const tenant=tr.body.data;
 assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/spaces`).set(auth(withToken)).send({buildingId:building.id,spaceId:space.id})).status,201);
 assert.equal((await api().post(`/api/v1/tenant-companies/${tenant.id}/building-contexts`).set(auth(withToken)).send({buildingId:building.id})).status,201);
 return{client,building,space,tenant};
}
async function finalizedInvoice(f:Awaited<ReturnType<typeof fixture>>,options:{invoiceDate?:string;dueDate?:string;amount?:number}={}){
 const invoiceDate=options.invoiceDate??'2026-08-01',dueDate=options.dueDate??'2099-12-31',amount=options.amount??1000;
 const charge=await api().post(`/api/v1/tenant-companies/${f.tenant.id}/charges`).set(auth()).send({buildingId:f.building.id,spaceId:f.space.id,chargeType:'SERVICE',description:'Charge',amount,currencyCode:'IDR',chargeDate:invoiceDate});
 assert.equal(charge.status,201,JSON.stringify(charge.body));
 const inv=await api().post(`/api/v1/tenant-companies/${f.tenant.id}/invoices`).set(auth()).send({buildingId:f.building.id,spaceId:f.space.id,invoiceNumber:`INV-${suffix()}`,invoiceDate,dueDate,currencyCode:'IDR'});
 assert.equal(inv.status,201,JSON.stringify(inv.body));
 assert.equal((await api().post(`/api/v1/tenant-invoices/${inv.body.data.id}/lines`).set(auth()).send({sourceType:'TENANT_CHARGE',sourceId:charge.body.data.id})).status,201);
 const finalized=await api().post(`/api/v1/tenant-invoices/${inv.body.data.id}/finalize`).set(auth()).send({});
 assert.equal(finalized.status,200,JSON.stringify(finalized.body));return finalized.body.data;
}
async function record(invoiceId:string,paidAmount:number,extra:Record<string,unknown>={}){return api().post(`/api/v1/tenant-invoices/${invoiceId}/payment-status`).set(auth()).send({paidAmount,...extra})}

describe('BE-19E Invoice Payment Status',()=>{
 it('validates amounts and resolves statuses without database access',()=>{
  assert.throws(()=>parseRecordInvoicePaymentStatusBody({paidAmount:-1}));
  assert.equal(resolveInvoicePaymentStatus({invoiceStatus:'FINALIZED',invoiceTotal:1000,paidAmount:0,dueDate:'2099-01-01'}).paymentStatus,'UNPAID');
  assert.equal(resolveInvoicePaymentStatus({invoiceStatus:'FINALIZED',invoiceTotal:1000,paidAmount:400,dueDate:'2099-01-01'}).paymentStatus,'PARTIALLY_PAID');
  assert.equal(resolveInvoicePaymentStatus({invoiceStatus:'FINALIZED',invoiceTotal:1000,paidAmount:1000,dueDate:'2099-01-01'}).paymentStatus,'PAID');
  assert.equal(resolveInvoicePaymentStatus({invoiceStatus:'FINALIZED',invoiceTotal:1000,paidAmount:0,dueDate:'2020-01-01'}).paymentStatus,'OVERDUE');
 });
 it('records UNPAID and supports get/list filters',async t=>{if(!ready(t))return;const f=await fixture(),invoice=await finalizedInvoice(f);const response=await record(invoice.id,0);
  assert.equal(response.status,201,JSON.stringify(response.body));assert.equal(response.body.data.paymentStatus,'UNPAID');assert.equal(response.body.data.outstandingAmount,1000);
  assert.equal((await api().get(`/api/v1/tenant-invoices/${invoice.id}/payment-status`).set(auth())).status,200);
  const list=await api().get('/api/v1/invoice-payment-statuses').query({tenantCompanyId:f.tenant.id,buildingId:f.building.id,status:'UNPAID'}).set(auth());assert.equal(list.status,200);assert.equal(list.body.data.length,1);
 });
 it('resolves PARTIALLY_PAID and consistent outstanding amount',async t=>{if(!ready(t))return;const f=await fixture(),invoice=await finalizedInvoice(f),created=await record(invoice.id,0);
  const updated=await api().patch(`/api/v1/invoice-payment-statuses/${created.body.data.id}`).set(auth()).send({paidAmount:400,paidAt:'2026-08-10T00:00:00.000Z',paymentReference:'MANUAL-001'});
  assert.equal(updated.status,200,JSON.stringify(updated.body));assert.equal(updated.body.data.paymentStatus,'PARTIALLY_PAID');assert.equal(updated.body.data.paidAmount,400);assert.equal(updated.body.data.outstandingAmount,600);
 });
 it('resolves PAID with zero outstanding amount',async t=>{if(!ready(t))return;const f=await fixture(),invoice=await finalizedInvoice(f);const response=await record(invoice.id,1000,{paidAt:'2026-08-10T00:00:00.000Z',paymentReference:'MANUAL-PAID'});
  assert.equal(response.status,201,JSON.stringify(response.body));assert.equal(response.body.data.paymentStatus,'PAID');assert.equal(response.body.data.outstandingAmount,0);
 });
 it('marks an unpaid past-due Invoice OVERDUE',async t=>{if(!ready(t))return;const f=await fixture(),invoice=await finalizedInvoice(f,{invoiceDate:'2020-01-01',dueDate:'2020-02-01'});const response=await record(invoice.id,0);
  assert.equal(response.status,201,JSON.stringify(response.body));assert.equal(response.body.data.paymentStatus,'OVERDUE');assert.equal(response.body.data.outstandingAmount,1000);
 });
 it('rejects an invalid or non-finalized Invoice',async t=>{if(!ready(t))return;const unknown=await record(randomUUID(),0);assert.equal(unknown.status,404);assert.equal(unknown.body.error.code,'TENANT_INVOICE_NOT_FOUND');
  const f=await fixture();const draft=await api().post(`/api/v1/tenant-companies/${f.tenant.id}/invoices`).set(auth()).send({buildingId:f.building.id,spaceId:f.space.id,invoiceNumber:`INV-${suffix()}`,invoiceDate:'2026-08-01',dueDate:'2099-01-01',currencyCode:'IDR'});
  const invalid=await record(draft.body.data.id,0);assert.equal(invalid.status,400);assert.equal(invalid.body.error.code,'INVOICE_PAYMENT_STATUS_INVOICE_INVALID');
 });
 it('rejects invalid paid amounts and missing paid_at',async t=>{if(!ready(t))return;const f=await fixture(),invoice=await finalizedInvoice(f);
  const excessive=await record(invoice.id,1001,{paidAt:'2026-08-10T00:00:00.000Z'});assert.equal(excessive.status,400);assert.equal(excessive.body.error.code,'INVOICE_PAYMENT_STATUS_AMOUNT_INVALID');
  const missing=await record(invoice.id,100);assert.equal(missing.status,400);assert.equal(missing.body.error.code,'INVOICE_PAYMENT_STATUS_PAID_AT_REQUIRED');
 });
 it('never modifies the authoritative finalized Invoice amount and preserves history',async t=>{if(!ready(t))return;const f=await fixture(),invoice=await finalizedInvoice(f,{amount:1250});const created=await record(invoice.id,250,{paidAt:'2026-08-10T00:00:00.000Z'});
  await api().patch(`/api/v1/invoice-payment-statuses/${created.body.data.id}`).set(auth()).send({paidAmount:1250,paidAt:'2026-08-11T00:00:00.000Z'});
  const read=await api().get(`/api/v1/tenant-invoices/${invoice.id}`).set(auth());assert.equal(read.body.data.totalAmount,1250);assert.equal(read.body.data.status,'FINALIZED');
  const history=await pool!.query('SELECT payment_status FROM invoice_payment_status_history WHERE invoice_payment_status_id=$1 ORDER BY changed_at',[created.body.data.id]);assert.deepEqual(history.rows.map(r=>r.payment_status),['PARTIALLY_PAID','PAID']);
 });
 it('enforces RBAC',async t=>{if(!ready(t))return;const f=await fixture(),invoice=await finalizedInvoice(f),plain=await createPlainSession();const response=await api().post(`/api/v1/tenant-invoices/${invoice.id}/payment-status`).set(auth(plain)).send({paidAmount:0});assert.equal(response.status,403);assert.equal(response.body.error.code,'PERMISSION_DENIED');
 });
 it('enforces Client and Building isolation',async t=>{if(!ready(t))return;const f=await fixture(),invoice=await finalizedInvoice(f),created=await record(invoice.id,0),other=await createAdminUser();await fixture(other.userId,other.token);
  const denied=await api().get(`/api/v1/tenant-invoices/${invoice.id}/payment-status`).set(auth(other.token));assert.equal(denied.status,403);assert.equal(denied.body.error.code,'BUILDING_ACCESS_DENIED');
  const list=await api().get('/api/v1/invoice-payment-statuses').set(auth(other.token));assert.equal(list.status,200);assert.equal(list.body.data.some((x:{id:string})=>x.id===created.body.data.id),false);
 });
});
