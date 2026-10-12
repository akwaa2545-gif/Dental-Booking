import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {Dashboard} from '../../src/web/admin/Dashboard';
import {ApiRequestError, SessionRefreshError, type ApiClient} from '../../src/web/api';

const path='/api/admin/line/notification-readiness';
const now=()=>new Date('2026-10-12T04:00:00Z');
const observedAt='2026-10-12T03:59:45.000Z';
const valid=()=>({matched:true,quota:{type:'limited',value:300,totalUsage:17,observedAt}});
const title='ตรวจการเชื่อมต่อและโควตา LINE';
const button=()=>screen.getByRole('button',{name:'ตรวจระบบแจ้งเตือน'});
function deferred(){let resolve!:(value:unknown)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<unknown>((ok,fail)=>{resolve=ok;reject=fail;});return{promise,resolve,reject};}
function client(read:()=>Promise<unknown>=async()=>valid(),mode:'server'|'demo'='server'){
 const request=vi.fn(async(url:string)=>url===path?read():[]);
 const api:ApiClient={dataMode:mode,request:request as ApiClient['request']};
 return{api,request};
}
function mount(api:ApiClient){return render(<Dashboard api={api} now={now} section="notifications"/>);}
async function check(){fireEvent.click(button());await waitFor(()=>expect(screen.queryByRole('button',{name:'กำลังตรวจระบบ…'})).not.toBeInTheDocument());}

describe('recovered notification readiness UI',()=>{
 it('is explicit, server-only, read-only, and does not request readiness on mount',async()=>{
  const c=client();mount(c.api);await screen.findByRole('region',{name:'ผลการแจ้งเตือนแอดมิน'});
  const region=screen.getByRole('region',{name:title});expect(within(region).getByRole('heading',{name:title})).toBeVisible();
  expect(region).toHaveTextContent('ไม่ส่งข้อความ ไม่เปิดการแจ้งเตือน และไม่ยืนยันว่าเป็นแพ็กเกจฟรี');
  expect(c.request.mock.calls.some(([url])=>url===path)).toBe(false);
  await check();expect(c.request.mock.calls.filter(([url])=>url===path)).toEqual([[path,{method:'GET'}]]);
  expect(region).toHaveTextContent('บัญชี LINE ตรงกับที่กำหนด');expect(region).toHaveTextContent('ยืนยันการเชื่อมต่อ ณ เวลาตรวจ');
  expect(region).toHaveTextContent('ขีดจำกัดจาก API: 300 ข้อความ');expect(region).toHaveTextContent('การใช้จาก API: 17 ข้อความ');
  expect(region.querySelector('time')).toHaveAttribute('dateTime',observedAt);expect(region).toHaveTextContent('เวลาไทย');
 });
 it('keeps readiness available when appointment data cannot be loaded',async()=>{
  const request=vi.fn(async(url:string)=>{if(url===path)return valid();throw new ApiRequestError('UNAVAILABLE',503);});
  mount({dataMode:'server',request:request as ApiClient['request']});await screen.findByRole('alert');
  await check();expect(screen.getByText('บัญชี LINE ตรงกับที่กำหนด')).toBeVisible();
 });
 it('does not expose the control in demo mode',async()=>{
  const c=client(async()=>valid(),'demo');mount(c.api);await screen.findByRole('region',{name:'ผลการแจ้งเตือนแอดมิน'});
  expect(screen.queryByRole('region',{name:title})).not.toBeInTheDocument();expect(c.request.mock.calls.some(([url])=>url===path)).toBe(false);
 });
 it('prevents repeated clicks while one read is pending',async()=>{
  const pending=deferred(),c=client(()=>pending.promise);mount(c.api);const control=button();
  fireEvent.click(control);fireEvent.click(control);expect(screen.getByRole('button',{name:'กำลังตรวจระบบ…'})).toBeDisabled();
  expect(screen.getByRole('region',{name:title})).toHaveAttribute('aria-busy','true');
  expect(c.request.mock.calls.filter(([url])=>url===path)).toHaveLength(1);
  await act(async()=>pending.resolve(valid()));expect(button()).toBeEnabled();
 });
 it('only displays allowlisted values and never raw identity, credentials, or diagnostics',async()=>{
  const c=client(async()=>({...valid(),token:'PRIVATE_TOKEN',botUserId:'PRIVATE_ID',diagnostic:'PRIVATE_DIAGNOSTIC',quota:{...valid().quota,secret:'PRIVATE_QUOTA'}}));
  mount(c.api);await check();expect(screen.getByText('บัญชี LINE ตรงกับที่กำหนด')).toBeVisible();
  expect(document.body).not.toHaveTextContent(/PRIVATE/);
 });
 it('shows a mismatch without quota or freshness claims',async()=>{
  const c=client(async()=>({matched:false,quota:null}));mount(c.api);await check();
  expect(screen.getByText('บัญชี LINE ไม่ตรงกับที่กำหนด ยังยืนยันการเชื่อมต่อไม่ได้')).toBeVisible();
  expect(screen.queryByText(/ขีดจำกัดจาก API/)).not.toBeInTheDocument();expect(screen.queryByText('ยืนยันการเชื่อมต่อ ณ เวลาตรวจ')).not.toBeInTheDocument();
 });
 it.each([
  null,[],{matched:'true',quota:null},{matched:false,quota:{value:300}},{matched:true,quota:null},
  ...[{type:'unlimited'},{value:-1},{value:1.5},{value:Number.MAX_SAFE_INTEGER+1},{value:'300'},{totalUsage:-1},{totalUsage:0.5},{totalUsage:'17'},
   {observedAt:'2026-02-30T04:00:00Z'},{observedAt:'2025-02-29T04:00:00Z'},{observedAt:'2026-10-12'},{observedAt:'2026-10-12T04:00:00Z\n'},{observedAt:'PRIVATE_DATE'},
  ].map(quota=>({matched:true,quota:{...valid().quota,...quota}})),
 ])('rejects malformed readiness without rendering values: %j',async value=>{
  const c=client(async()=>value);mount(c.api);await check();
  expect(screen.getByRole('alert')).toHaveTextContent('ยังยืนยันข้อมูลตรวจระบบไม่ได้ โปรดลองตรวจใหม่ภายหลัง');
  expect(screen.queryByText(/ขีดจำกัดจาก API/)).not.toBeInTheDocument();expect(document.body).not.toHaveTextContent('PRIVATE_DATE');
 });
 it.each([
  ['2026-10-12T03:59:00.000Z',true],['2026-10-12T03:58:59.999Z',false],['2026-10-12T04:00:00.001Z',false],['2026-10-12T11:00:00+07:00',true],
 ])('validates freshness and normalizes the valid timestamp %s',async(timestamp,fresh)=>{
  const c=client(async()=>({matched:true,quota:{...valid().quota,observedAt:timestamp}}));mount(c.api);await check();
  expect(screen.getByText(fresh?'ยืนยันการเชื่อมต่อ ณ เวลาตรวจ':'เวลาตรวจยังยืนยันไม่ได้ โปรดลองตรวจใหม่ภายหลัง')).toBeVisible();
  expect(screen.getByRole('region',{name:title}).querySelector('time')).toHaveAttribute('dateTime',new Date(timestamp).toISOString());
 });
 it.each([
  [new ApiRequestError('UNAUTHENTICATED',401),'เซสชันสิ้นสุด กรุณาเข้าสู่ระบบอีกครั้ง'],
  [new ApiRequestError('FORBIDDEN',403),'ไม่มีสิทธิ์ตรวจระบบนี้ กรุณาตรวจสอบบัญชีและสิทธิ์ผู้ดูแล'],
  [new ApiRequestError('RATE_LIMITED',429),'ตรวจระบบบ่อยเกินไป โปรดลองใหม่ภายหลัง'],
  [new SessionRefreshError(new ApiRequestError('UNAVAILABLE',503)),'ยังตรวจสอบเซสชันไม่ได้ กรุณาเข้าสู่ระบบอีกครั้ง'],
  [new Error('PRIVATE_PROVIDER_DETAIL'),'ยังเชื่อมต่อเพื่อตรวจระบบไม่ได้ โปรดลองใหม่ภายหลัง'],
 ])('displays safe errors without provider detail: %s',async(error,label)=>{
  const c=client(async()=>{throw error;});mount(c.api);await check();expect(screen.getByRole('alert')).toHaveTextContent(label as string);
  expect(document.body).not.toHaveTextContent('PRIVATE_PROVIDER_DETAIL');
 });
 it('clears the previous result before a new read and does not restore it after a failure',async()=>{
  const pending=deferred();let count=0;const c=client(()=>++count===1?Promise.resolve(valid()):pending.promise);
  mount(c.api);await check();expect(screen.getByText(/ขีดจำกัดจาก API/)).toBeVisible();fireEvent.click(button());
  expect(screen.queryByText(/ขีดจำกัดจาก API/)).not.toBeInTheDocument();
  await act(async()=>pending.reject(Error('PRIVATE')));expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.queryByText(/ขีดจำกัดจาก API/)).not.toBeInTheDocument();
 });
 it('fences a pending read after the account-bound API changes and allows a fresh read',async()=>{
  const old=deferred(),a=client(()=>old.promise),b=client(async()=>({matched:false,quota:null}));const view=mount(a.api);
  fireEvent.click(button());view.rerender(<Dashboard api={b.api} now={now} section="notifications"/>);
  expect(button()).toBeEnabled();await check();expect(screen.getByText('บัญชี LINE ไม่ตรงกับที่กำหนด ยังยืนยันการเชื่อมต่อไม่ได้')).toBeVisible();
  await act(async()=>old.resolve(valid()));expect(screen.queryByText('บัญชี LINE ตรงกับที่กำหนด')).not.toBeInTheDocument();
  expect(screen.queryByText(/ขีดจำกัดจาก API/)).not.toBeInTheDocument();
 });
 it('drops pending results after navigation away and does not replay the request when returning',async()=>{
  const pending=deferred(),c=client(()=>pending.promise),view=mount(c.api);fireEvent.click(button());
  view.rerender(<Dashboard api={c.api} now={now} section="overview"/>);await act(async()=>pending.resolve(valid()));
  view.rerender(<Dashboard api={c.api} now={now} section="notifications"/>);expect(button()).toBeEnabled();
  expect(screen.queryByText(/ขีดจำกัดจาก API/)).not.toBeInTheDocument();expect(c.request.mock.calls.filter(([url])=>url===path)).toHaveLength(1);
 });
});
