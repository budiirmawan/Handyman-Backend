import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isPermitContractorContextType, type PermitContractorContextType } from '../permits/permit.types';
import {
  PERMIT_EVIDENCE_TYPES,
  isPermitEvidenceType,
  type CreatePermitEvidenceRequirementInput,
  type PermitEvidenceFilters,
  type PermitEvidenceType,
  type SubmitPermitEvidenceInput,
} from './permit-evidence.types';

type Detail={field:string;message:string};
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function rec(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v)}
function fail(d:Detail[]):never{throw AppError.validation('Request validation failed.',d)}
export const parsePermitEvidencePermitIdParam=(r:string)=>pid(r,'permitId');
export const parsePermitEvidenceIdParam=(r:string)=>pid(r,'evidenceId');

export function parseCreatePermitEvidenceRequirementBody(body:unknown):CreatePermitEvidenceRequirementInput{
  if(!rec(body))fail([{field:'body',message:'Request body must be a JSON object.'}]);
  const d:Detail[]=[],buildingId=id(body.buildingId,'buildingId',true,d),contractorContextType=ctype(body.contractorContextType,d),contractorContextId=id(body.contractorContextId,'contractorContextId',true,d),evidenceType=etype(body.evidenceType,d),required=bool(body.required,'required',d)??true,minimumCount=int(body.minimumCount,'minimumCount',d)??(required?1:0),maximumCount=body.maximumCount===null?null:int(body.maximumCount,'maximumCount',d),description=text(body.description,'description',2000,d);
  if(minimumCount<0)d.push({field:'minimumCount',message:'minimumCount must be non-negative.'});
  if(required&&minimumCount<1)d.push({field:'minimumCount',message:'Required evidence must have minimumCount of at least 1.'});
  if(maximumCount!==undefined&&maximumCount!==null&&maximumCount<minimumCount)d.push({field:'maximumCount',message:'maximumCount must be at least minimumCount.'});
  if(!buildingId||!contractorContextType||!contractorContextId||!evidenceType||d.length)fail(d);
  return{buildingId,contractorContextType,contractorContextId,evidenceType,required,minimumCount,maximumCount:maximumCount===undefined?null:maximumCount,...(description!==undefined?{description}:{})};
}

export function parseSubmitPermitEvidenceBody(body:unknown):SubmitPermitEvidenceInput{
  if(!rec(body))fail([{field:'body',message:'Request body must be a JSON object.'}]);
  const d:Detail[]=[],buildingId=id(body.buildingId,'buildingId',true,d),contractorContextType=ctype(body.contractorContextType,d),contractorContextId=id(body.contractorContextId,'contractorContextId',true,d),evidenceRequirementId=id(body.evidenceRequirementId,'evidenceRequirementId',true,d),evidenceType=etype(body.evidenceType,d),fileReference=reqtext(body.fileReference,'fileReference',512,d),originalFileName=reqtext(body.originalFileName,'originalFileName',255,d),mimeType=reqtext(body.mimeType,'mimeType',255,d),fileSize=filesize(body.fileSize,d),capturedAt=timestamp(body.capturedAt,'capturedAt',false,d);
  if(!buildingId||!contractorContextType||!contractorContextId||!evidenceRequirementId||!evidenceType||!fileReference||!originalFileName||!mimeType||fileSize===undefined||d.length)fail(d);
  return{buildingId,contractorContextType,contractorContextId,evidenceRequirementId,evidenceType,fileReference,originalFileName,mimeType,fileSize,...(capturedAt?{capturedAt}:{})};
}

export function parsePermitEvidenceFilters(q:unknown):PermitEvidenceFilters{
  if(!rec(q))return{};const d:Detail[]=[],permitId=id(q.permitId,'permitId',false,d),buildingId=id(q.buildingId,'buildingId',false,d),contractorVendorId=id(q.contractorVendorId??q.contractorId,'contractorVendorId',false,d),evidenceType=q.evidenceType===undefined?undefined:etype(q.evidenceType,d),status=statusValue(q.status,d);if(d.length)fail(d);return{...(permitId?{permitId}:{}),...(buildingId?{buildingId}:{}),...(contractorVendorId?{contractorVendorId}:{}),...(evidenceType?{evidenceType}:{}),...(status?{status}:{})};
}
function pid(r:string,f:string){const v=r.trim().toLowerCase();if(!isValidUuid(v))fail([{field:f,message:`${f} must be a valid UUID.`}]);return v}
function id(v:unknown,f:string,r:boolean,d:Detail[]){if(v===undefined&&!r)return undefined;if(typeof v!=='string'||!isValidUuid(v.trim())){d.push({field:f,message:`${f}${r?' is required and':''} must be a valid UUID.`});return undefined}return v.trim().toLowerCase()}
function ctype(v:unknown,d:Detail[]):PermitContractorContextType|undefined{const n=typeof v==='string'?v.trim().toUpperCase():v;if(!isPermitContractorContextType(n)){d.push({field:'contractorContextType',message:'contractorContextType is invalid.'});return undefined}return n}
function etype(v:unknown,d:Detail[]):PermitEvidenceType|undefined{const n=typeof v==='string'?v.trim().toUpperCase():v;if(!isPermitEvidenceType(n)){d.push({field:'evidenceType',message:`evidenceType must be one of: ${PERMIT_EVIDENCE_TYPES.join(', ')}.`});return undefined}return n}
function bool(v:unknown,f:string,d:Detail[]){if(v===undefined)return undefined;if(typeof v!=='boolean'){d.push({field:f,message:`${f} must be a boolean.`});return undefined}return v}
function int(v:unknown,f:string,d:Detail[]){if(v===undefined)return undefined;if(typeof v!=='number'||!Number.isInteger(v)){d.push({field:f,message:`${f} must be an integer.`});return undefined}return v}
function text(v:unknown,f:string,m:number,d:Detail[]):string|null|undefined{if(v===undefined)return undefined;if(v===null)return null;if(typeof v!=='string'){d.push({field:f,message:`${f} must be a string or null.`});return undefined}const s=v.trim();if(s.length>m)d.push({field:f,message:`${f} is too long.`});return s||null}
function reqtext(v:unknown,f:string,m:number,d:Detail[]){if(typeof v!=='string'||!v.trim()){d.push({field:f,message:`${f} is required.`});return undefined}const s=v.trim();if(s.length>m){d.push({field:f,message:`${f} is too long.`});return undefined}return s}
function filesize(v:unknown,d:Detail[]){if(typeof v!=='number'||!Number.isInteger(v)||v<0||v>52_428_800){d.push({field:'fileSize',message:'fileSize must be between 0 and 52428800.'});return undefined}return v}
function timestamp(v:unknown,f:string,r:boolean,d:Detail[]){if(v===undefined&&!r)return undefined;if(typeof v!=='string'||!ISO.test(v.trim())){d.push({field:f,message:`${f} must be an ISO-8601 date-time with timezone.`});return undefined}const x=new Date(v);if(Number.isNaN(x.getTime())){d.push({field:f,message:`${f} must be valid.`});return undefined}return x}
function statusValue(v:unknown,d:Detail[]):'ACTIVE'|'REMOVED'|undefined{if(v===undefined)return undefined;const n=typeof v==='string'?v.trim().toUpperCase():v;if(n!=='ACTIVE'&&n!=='REMOVED'){d.push({field:'status',message:'status must be ACTIVE or REMOVED.'});return undefined}return n}
