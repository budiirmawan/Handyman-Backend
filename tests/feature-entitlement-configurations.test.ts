import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { entitlementService } from '../src/modules/entitlements';
import { featureEntitlementConfigurationRepository } from '../src/modules/feature-entitlement-configurations/feature-entitlement-configuration.repository';
import { licenseService } from '../src/modules/licenses';
import { moduleConfigurationRepository } from '../src/modules/module-configurations/module-configuration.repository';
import { moduleService } from '../src/modules/modules';
import { propertyService } from '../src/modules/properties';
import { subscriptionService } from '../src/modules/subscriptions';
import { createAdminUser, createPlainSession } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const DB_PORT = 55457;
const DATA_DIR = '/tmp/asentra-be27d-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const START = new Date('2026-01-01T00:00:00.000Z');
const END = new Date('2027-12-31T00:00:00.000Z');
process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'error'; process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) { process.env.DB_HOST='127.0.0.1'; process.env.DB_PORT=String(DB_PORT); process.env.DB_USER='postgres'; process.env.DB_PASSWORD='postgres'; process.env.DB_SSL='false'; }

let postgres: EmbeddedPostgres|null=null, database:DatabaseConfig|null=null, pool:Pool|null=null;
let adminToken='', adminUserId='', plainToken='', clientA='', buildingA='', sibling='', clientB='', buildingB='', subscriptionA='';
let siblingFeatureId='', otherFeatureId='';
const suffix=()=>randomUUID().slice(0,8).toUpperCase();
const auth=(token=adminToken)=>({Authorization:`Bearer ${token}`});
const ok=(t:TestContext)=>{if(!database||!pool){t.skip('BE-27D database unavailable');return false}return true};

async function module(status:'ACTIVE'|'INACTIVE'='ACTIVE'){const code=`FEAT_${suffix()}`;return moduleService.createModule({code,name:code,status})}
async function scope(assign?:string,count=1){const client=await clientService.createClient({code:`FC_${suffix()}`,name:'Feature Client'});const property=await propertyService.createProperty({clientId:client.id,code:`P_${suffix()}`,name:'Feature Property'});const buildings=[];for(let i=0;i<count;i++)buildings.push(await buildingService.createBuilding({propertyId:property.id,code:`B_${suffix()}`,name:`Building ${i}`}));if(assign)await buildingAssignmentService.createAssignment(assign,{buildingId:buildings[0].id});return{client,buildings}}
async function entitle(moduleId:string){return entitlementService.createEntitlement(subscriptionA,{moduleId,startsAt:START,endsAt:END})}
async function moduleBinding(moduleId:string,enabled:boolean,buildingId:string|null=null){return moduleConfigurationRepository.create({scopeType:buildingId?'BUILDING':'CLIENT',clientId:buildingId?null:clientA,buildingId,moduleId,enabled})}
async function createClientFeature(moduleKey:string,featureKey:string,state:'ENABLED'|'DISABLED'){const response=await api().post(`/api/v1/clients/${clientA}/feature-entitlements`).set(auth()).send({moduleKey,featureKey,state});if(response.status===201)await activateLatestConfigurationVersion(adminToken,'FEATURE_ENTITLEMENT_CONFIGURATION',response.body.data.id);return response}
async function createBuildingFeature(moduleKey:string,featureKey:string,state:'ENABLED'|'DISABLED'){const response=await api().post(`/api/v1/buildings/${buildingA}/feature-entitlements`).set(auth()).send({moduleKey,featureKey,state});if(response.status===201)await activateLatestConfigurationVersion(adminToken,'FEATURE_ENTITLEMENT_CONFIGURATION',response.body.data.id);return response}

before(async()=>{if(EMBEDDED){await rm(DATA_DIR,{recursive:true,force:true});await mkdir(DATA_DIR,{recursive:true});postgres=new EmbeddedPostgres({databaseDir:DATA_DIR,port:DB_PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});await postgres.initialise();await postgres.start();const a=postgres.getPgClient('postgres','127.0.0.1');await a.connect();await a.query('CREATE DATABASE asentra_test');await a.end()}
const db=await ensureTestDatabase();if(!db)return;database=db;pool=await initDatabase(db);await migrateUp(pool);await pool.query(`TRUNCATE feature_entitlement_configurations,module_configurations,building_configurations,client_configurations,module_entitlements,licenses,subscriptions,modules,user_building_assignments,buildings,properties,clients,user_sessions,user_credentials,role_permission_assignments,user_role_assignments,permissions,roles,users CASCADE`);
const admin=await createAdminUser();adminToken=admin.token;adminUserId=admin.userId;plainToken=await createPlainSession();const a=await scope(adminUserId,2);clientA=a.client.id;buildingA=a.buildings[0].id;sibling=a.buildings[1].id;const sub=await subscriptionService.createSubscription({clientId:clientA,code:`S_${suffix()}`,planCode:'ENTERPRISE',startsAt:START,endsAt:END});subscriptionA=sub.id;await licenseService.createLicense(sub.id,{validFrom:START,validUntil:END});
const sm=await module();siblingFeatureId=(await featureEntitlementConfigurationRepository.create({scopeType:'BUILDING',clientId:null,buildingId:sibling,moduleId:sm.id,featureKey:'PRIVATE',state:'ENABLED'})).id;const b=await scope(undefined,1);clientB=b.client.id;buildingB=b.buildings[0].id;const om=await module();otherFeatureId=(await featureEntitlementConfigurationRepository.create({scopeType:'CLIENT',clientId:clientB,buildingId:null,moduleId:om.id,featureKey:'PRIVATE',state:'ENABLED'})).id;});
after(async()=>{
  try {
    if(pool) await closePool(pool);
    if(postgres) await postgres.stop();
  } finally {
    await rm(DATA_DIR,{recursive:true,force:true});
  }
  pool=null; postgres=null; database=null;
});

describe('BE-27D Feature entitlement records',()=>{
it('creates Client and Building bindings with Module dependency',async t=>{if(!ok(t))return;const m=await module();let r=await createClientFeature(m.code.toLowerCase(),' work_order.create ','ENABLED');assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.data.scopeType,'CLIENT');assert.equal(r.body.data.clientId,clientA);assert.equal(r.body.data.moduleId,m.id);assert.equal(r.body.data.featureKey,'WORK_ORDER.CREATE');r=await createBuildingFeature(m.code,'WORK_ORDER.CREATE','DISABLED');assert.equal(r.status,201);assert.equal(r.body.data.scopeType,'BUILDING');assert.equal(r.body.data.clientId,clientA);assert.equal(r.body.data.buildingId,buildingA)});
it('enforces uniqueness, lists, gets and updates state',async t=>{if(!ok(t))return;const m=await module();const created=await createClientFeature(m.code,'DASHBOARD.VIEW','ENABLED');const duplicate=await createClientFeature(m.code,'dashboard.view','DISABLED');assert.equal(duplicate.status,409);assert.equal(duplicate.body.error.code,'FEATURE_ENTITLEMENT_CONFIGURATION_ALREADY_EXISTS');const list=await api().get(`/api/v1/clients/${clientA}/feature-entitlements`).set(auth());assert.equal(list.status,200);const one=await api().get(`/api/v1/feature-entitlements/${created.body.data.id}`).set(auth());assert.equal(one.status,200);const updated=await api().patch(`/api/v1/feature-entitlements/${created.body.data.id}`).set(auth()).send({state:'DISABLED'});assert.equal(updated.status,200);assert.equal(updated.body.data.state,'DISABLED')});
});

describe('BE-27D effective Feature entitlement',()=>{
it('cannot enable a Feature when its Module is disabled or commercially unentitled',async t=>{if(!ok(t))return;const allowed=await module(),unentitled=await module(),moduleDisabled=await module(),noModuleConfig=await module();await entitle(allowed.id);await entitle(moduleDisabled.id);await entitle(noModuleConfig.id);await moduleBinding(allowed.id,true);await moduleBinding(unentitled.id,true);await moduleBinding(moduleDisabled.id,false);await createClientFeature(allowed.code,'ALLOWED','ENABLED');await createClientFeature(unentitled.code,'NO_ENTITLEMENT','ENABLED');await createClientFeature(moduleDisabled.code,'MODULE_DISABLED','ENABLED');await createClientFeature(noModuleConfig.code,'NO_MODULE_CONFIG','ENABLED');const r=await api().get(`/api/v1/clients/${clientA}/feature-entitlements/effective`).set(auth());assert.equal(r.status,200,JSON.stringify(r.body));const map=new Map(r.body.data.features.map((x:any)=>[x.featureKey,x]));assert.equal(map.get('ALLOWED').state,'ENABLED');assert.equal(map.get('ALLOWED').moduleEnabled,true);for(const key of ['NO_ENTITLEMENT','MODULE_DISABLED','NO_MODULE_CONFIG']){assert.equal(map.get(key).configuredState,'ENABLED');assert.equal(map.get(key).moduleEnabled,false);assert.equal(map.get(key).state,'DISABLED')}});
it('applies Building Feature override and Building Module dependency',async t=>{if(!ok(t))return;const enabled=await module(),blocked=await module();await entitle(enabled.id);await entitle(blocked.id);await moduleBinding(enabled.id,true);await moduleBinding(blocked.id,true);await moduleBinding(blocked.id,false,buildingA);await createClientFeature(enabled.code,'OVERRIDE','DISABLED');await createBuildingFeature(enabled.code,'OVERRIDE','ENABLED');await createBuildingFeature(blocked.code,'BLOCKED','ENABLED');const r=await api().get(`/api/v1/buildings/${buildingA}/feature-entitlements/effective`).set(auth());assert.equal(r.status,200);const map=new Map(r.body.data.features.map((x:any)=>[x.featureKey,x]));assert.equal(map.get('OVERRIDE').source,'BUILDING');assert.equal(map.get('OVERRIDE').state,'ENABLED');assert.equal(map.get('BLOCKED').moduleEnabled,false);assert.equal(map.get('BLOCKED').state,'DISABLED')});
});

describe('BE-27D validation, RBAC and isolation',()=>{
it('requires active Module, valid state and immutable references',async t=>{if(!ok(t))return;let r=await createClientFeature('UNKNOWN_MODULE','X','ENABLED');assert.equal(r.status,404);const inactive=await module('INACTIVE');r=await createClientFeature(inactive.code,'X','ENABLED');assert.equal(r.body.error.code,'MODULE_INACTIVE');r=await api().post(`/api/v1/clients/${clientA}/feature-entitlements`).set(auth()).send({moduleKey:inactive.code,featureKey:'bad key!',state:'YES'});assert.equal(r.status,400);const m=await module();const c=await createClientFeature(m.code,'IMMUTABLE','ENABLED');r=await api().patch(`/api/v1/feature-entitlements/${c.body.data.id}`).set(auth()).send({featureKey:'CHANGED',state:'DISABLED'});assert.equal(r.status,400)});
it('requires authentication and dedicated permission',async t=>{if(!ok(t))return;let r=await api().get(`/api/v1/clients/${clientA}/feature-entitlements`);assert.equal(r.status,401);const m=await module();r=await api().post(`/api/v1/clients/${clientA}/feature-entitlements`).set(auth(plainToken)).send({moduleKey:m.code,featureKey:'DENIED',state:'ENABLED'});assert.equal(r.status,403);assert.equal(r.body.error.code,'PERMISSION_DENIED')});
it('denies same-Client sibling and cross-Client access',async t=>{if(!ok(t))return;for(const path of [`/api/v1/buildings/${sibling}/feature-entitlements`,`/api/v1/buildings/${sibling}/feature-entitlements/effective`,`/api/v1/feature-entitlements/${siblingFeatureId}`,`/api/v1/clients/${clientB}/feature-entitlements`,`/api/v1/clients/${clientB}/feature-entitlements/effective`,`/api/v1/buildings/${buildingB}/feature-entitlements`,`/api/v1/feature-entitlements/${otherFeatureId}`]){const r=await api().get(path).set(auth());assert.equal(r.status,403,path);assert.equal(r.body.error.code,'BUILDING_ACCESS_DENIED')}});
});

describe('BE-27D OpenAPI contract',()=>{it('documents Feature configuration in the final BE-27 contract',()=>{const spec=parse(readFileSync(resolve(__dirname,'../docs/api/openapi.yaml'),'utf8'));for(const p of ['/clients/{clientId}/feature-entitlements','/clients/{clientId}/feature-entitlements/effective','/buildings/{buildingId}/feature-entitlements','/buildings/{buildingId}/feature-entitlements/effective','/feature-entitlements/{featureEntitlementConfigurationId}'])assert.ok(spec.paths[p],p);for(const s of ['FeatureEntitlementConfiguration','FeatureEntitlementState','CreateFeatureEntitlementRequest','EffectiveFeatureEntitlementConfiguration'])assert.ok(spec.components.schemas[s],s);assert.ok(spec.paths['/clients/{clientId}/navigation-items'])})});
