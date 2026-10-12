import {z} from 'zod';
import {DatabaseError,type QueryPort} from '../db';
export type OAuthPending={stateHash:string;bindingHash:string;nonce:string;codeVerifier:string;returnPath:string;expiresAt:string};
export interface OAuthStore{save(pending:OAuthPending):Promise<void>;consume(stateHash:string,bindingHash:string):Promise<OAuthPending|null>;}
const hash=/^[0-9a-f]{64}$/;
const pendingSchema=z.object({stateHash:z.string().regex(hash),bindingHash:z.string().regex(hash),
 nonce:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),codeVerifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
 returnPath:z.string().max(2048).refine(value=>value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\')
  &&!Array.from(value).some(char=>char.charCodeAt(0)<=32||char.charCodeAt(0)===127)&&!/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)),
 expiresAt:z.iso.datetime({offset:true}),}).strict();

/** This adapter has no in-isolate fallback: a storage failure fails the login. */
export function createOAuthStore(port:QueryPort):OAuthStore{
 async function query(text:string,values:unknown[]):Promise<unknown>{
  try{
   const{rows}=await port.query(text,values);
   if(rows.length!==1||rows[0].result===undefined)throw new Error();
   return rows[0].result;
  }catch{throw new DatabaseError('UNAVAILABLE');}
 }
 return{
  async save(pending){
   const parsed=pendingSchema.safeParse(pending);
   if(!parsed.success)throw new DatabaseError('VALIDATION');
   const p=parsed.data;
   await query('select dental.save_oauth_pending($1::text, $2::text, $3::text, $4::text, $5::text, $6::timestamptz) as result',
    [p.stateHash,p.bindingHash,p.nonce,p.codeVerifier,p.returnPath,p.expiresAt]);
  },
  async consume(stateHash,bindingHash){
   if(!hash.test(stateHash)||!hash.test(bindingHash))return null;
   const value=await query('select dental.consume_oauth_pending($1::text, $2::text) as result',[stateHash,bindingHash]);
   if(value===null)return null;
   const parsed=pendingSchema.safeParse(value);
   if(!parsed.success||parsed.data.stateHash!==stateHash||parsed.data.bindingHash!==bindingHash)throw new DatabaseError('UNAVAILABLE');
   return parsed.data;
  },
 };
}
