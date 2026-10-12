import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../../src/web/admin/Dashboard';
import type { AdminAppointment } from '../../src/shared/contracts';
import { ApiRequestError, type ApiClient } from '../../src/web/api';
const now = () => new Date('2026-10-08T03:00:00Z');
const record: AdminAppointment = { id:'one', reference:'SYNTHETIC-one', patientId:'one', patient:{fullName:'Synthetic One',phone:'0000000000',address:'Synthetic',age:25,relationship:'self',authorizationAcknowledged:true},service:'scaling',date:'2026-10-09',status:'pending',version:1,createdAt:'2026-10-08T02:00:00Z',approvedAt:null,cancelBefore:'2026-10-08T17:00:00Z',notificationAttempts:[{kind:'approval',state:'accepted',attemptCount:1}] };
function client(): ApiClient { return {dataMode:'server', async request<T>(path:string){return (path==='/api/availability' ? [{date:'2026-10-09',state:'available'},{date:'2026-10-10',state:'ineligible'},{date:'2026-10-12',state:'paused'}] : [record]) as T;}}; }
describe('real admin workspace',()=>{
 it('shows five section links and real overview totals without prototype fixtures',async()=>{
  const onSectionChange=vi.fn();render(<Dashboard api={client()} now={now} section="overview" onSectionChange={onSectionChange}/>);
  expect(await screen.findByRole('heading',{name:'ภาพรวม'})).toBeVisible();
  expect(screen.getByRole('navigation',{name:'เมนูแอดมิน'})).toBeVisible();
  expect(screen.getByRole('button',{name:'ภาพรวม'})).toHaveAttribute('aria-current','page');
  expect(await screen.findByText('Synthetic One')).toBeVisible();
  await userEvent.click(screen.getByRole('button',{name:'ตารางนัด'}));expect(onSectionChange).toHaveBeenCalledWith('schedule');
  expect(screen.queryByLabelText('เหตุผลการเปลี่ยนแปลง')).not.toBeInTheDocument();
 });
 it('shows patient delivery outcomes and read-only admin LINE readiness',async()=>{
  render(<Dashboard api={client()} now={now} section="notifications"/>);
  expect(await screen.findByText('ผู้ให้บริการรับแล้ว · พยายามส่ง 1 ครั้ง')).toBeVisible();
  expect(screen.getByText(/ไม่ได้ยืนยันว่าผู้รับอ่านแล้ว/)).toBeVisible();
  expect(screen.getByText(/ระบบแจ้งเตือนนี้ปิดโดยค่าเริ่มต้น/)).toBeVisible();
  expect(screen.queryByRole('button',{name:'แจ้งเตือนการจองใหม่ไปยัง LINE แอดมิน'})).not.toBeInTheDocument();
  expect(screen.queryByLabelText('เหตุผลการเปลี่ยนแปลง')).not.toBeInTheDocument();
 });
 it('selects real schedule dates including paused days without enabling patient booking',async()=>{
  render(<Dashboard api={client()} now={now} section="schedule"/>);
  const day=await screen.findByRole('button',{name:/12 ตุลาคม.*หยุดรับคำขอ/});
  await userEvent.click(day);
  expect(day).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('region',{name:'สรุปวันที่เลือก'})).toHaveTextContent('หยุดรับคำขอ');
  expect(screen.queryByLabelText('เหตุผลการเปลี่ยนแปลง')).not.toBeInTheDocument();
 });
 it('intake keeps all unresolved appointments independent of queue filters',async()=>{
  render(<Dashboard api={client()} now={now} section="intake"/>);
  expect(await screen.findByLabelText('เหตุผลการเปลี่ยนแปลง')).toBeVisible();
  expect(within(screen.getByRole('region',{name:'คำขอและนัดที่ยังต้องจัดการ'})).getByText('Synthetic One')).toBeVisible();
  expect(screen.getByRole('button',{name:'พิจารณาคำขอ'})).toBeEnabled();
 });
 it('hides mutation controls and does not claim empty totals when initial load fails',async()=>{
  const api:ApiClient={dataMode:'server',request:async()=>{throw new ApiRequestError('UNAVAILABLE',503);}};
  render(<Dashboard api={api} now={now} section="intake"/>);
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByLabelText('เหตุผลการเปลี่ยนแปลง')).not.toBeInTheDocument();
  expect(screen.queryByText('0/3 ที่ใช้ในวันที่เลือก')).not.toBeInTheDocument();
 });
 it('recovers a failed initial read explicitly before showing day controls',async()=>{
  let failed=true; const real=client();
  const api:ApiClient={dataMode:'server',async request<T>(path:string){if(failed)throw new ApiRequestError('UNAVAILABLE',503);return real.request<T>(path);}};
  render(<Dashboard api={api} now={now} section="intake"/>);
  await screen.findByRole('alert'); failed=false;
  await userEvent.click(screen.getByRole('button',{name:'ตรวจสอบสถานะล่าสุด'}));
  expect(await screen.findByLabelText('เหตุผลการเปลี่ยนแปลง')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 });
 it('does not offer intake mutation for dates absent from current availability',async()=>{
  render(<Dashboard api={client()} now={now} section="intake"/>);
  await screen.findByLabelText('เหตุผลการเปลี่ยนแปลง');
  const input=screen.getByLabelText('วันที่นัด');
  await userEvent.clear(input);await userEvent.type(input,'2026-11-30');
  expect(screen.queryByLabelText('เหตุผลการเปลี่ยนแปลง')).not.toBeInTheDocument();
 });

 it('requires read recovery after an intake write with an uncertain refresh',async()=>{
  let uncertain=false;let writes=0;const real=client();
  const api:ApiClient={dataMode:'server',async request<T>(path:string,init?:RequestInit){
   if(init?.method==='PUT'){writes++;uncertain=true;return {} as T;}
   if(uncertain)throw new ApiRequestError('UNAVAILABLE',503);
   return real.request<T>(path);
  }};
  render(<Dashboard api={api} now={now} section="intake"/>);
  await userEvent.type(await screen.findByLabelText('เหตุผลการเปลี่ยนแปลง'),'เหตุผลสมมติ');
  await userEvent.click(screen.getByRole('button',{name:'บันทึกการรับคำขอ'}));
  expect(await screen.findByRole('button',{name:'ตรวจสอบสถานะล่าสุด'})).toBeVisible();
  expect(screen.queryByLabelText('เหตุผลการเปลี่ยนแปลง')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'พิจารณาคำขอ'})).toBeDisabled();
  expect(writes).toBe(1);uncertain=false;
  await userEvent.click(screen.getByRole('button',{name:'ตรวจสอบสถานะล่าสุด'}));
  expect(await screen.findByLabelText('เหตุผลการเปลี่ยนแปลง')).toBeVisible();
  expect(writes).toBe(1);
 });
 it('does not label an unselected queue date as zero occupied seats',async()=>{
  render(<Dashboard api={client()} now={now} section="queue"/>);
  await screen.findByText('1/3 ที่ใช้ในวันที่เลือก');
  await userEvent.click(screen.getByRole('button',{name:'ดูทุกวันและสถานะ'}));
  expect(screen.queryByText('0/3 ที่ใช้ในวันที่เลือก')).not.toBeInTheDocument();
  expect(screen.getByRole('region',{name:'สรุปวันที่เลือก'})).toHaveTextContent('ทุกวัน');
 });

 it('blocks repeat intake writes after a lost response until explicit read recovery',async()=>{
  let writes=0;const real=client();
  const api:ApiClient={dataMode:'server',async request<T>(path:string,init?:RequestInit){
   if(init?.method==='PUT'){writes++;throw new ApiRequestError('UNAVAILABLE',503);}
   return real.request<T>(path);
  }};
  render(<Dashboard api={api} now={now} section="intake"/>);
  await userEvent.type(await screen.findByLabelText('เหตุผลการเปลี่ยนแปลง'),'เหตุผลสมมติ');
  await userEvent.click(screen.getByRole('button',{name:'บันทึกการรับคำขอ'}));
  expect(await screen.findByRole('button',{name:'ตรวจสอบสถานะล่าสุด'})).toBeVisible();
  expect(screen.queryByLabelText('เหตุผลการเปลี่ยนแปลง')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'พิจารณาคำขอ'})).toBeDisabled();
  expect(writes).toBe(1);
  await userEvent.click(screen.getByRole('button',{name:'ตรวจสอบสถานะล่าสุด'}));
  expect(await screen.findByLabelText('เหตุผลการเปลี่ยนแปลง')).toBeVisible();
  expect(writes).toBe(1);
 });

 it('keeps a no-date schedule explicit after clearing queue filters',async()=>{
  const api=client();const view=render(<Dashboard api={api} now={now} section="queue"/>);
  await screen.findByText('1/3 ที่ใช้ในวันที่เลือก');
  await userEvent.click(screen.getByRole('button',{name:'ดูทุกวันและสถานะ'}));
  view.rerender(<Dashboard api={api} now={now} section="schedule"/>);
  expect(screen.getByText('เลือกวันจากปฏิทินเพื่อดูรายการ')).toBeVisible();
  expect(screen.queryByText('Synthetic One')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button',{name:/9 ตุลาคม.*เปิดรับคำขอ/}));
  expect(screen.getByText('Synthetic One')).toBeVisible();
 });
 it('dismisses a pending decision when history changes the workspace section',async()=>{
  const api=client();const view=render(<Dashboard api={api} now={now} section="queue"/>);
  await userEvent.click(await screen.findByRole('button',{name:'พิจารณาคำขอ'}));
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.popState(window);
  view.rerender(<Dashboard api={api} now={now} section="schedule"/>);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(<Dashboard api={api} now={now} section="queue"/>);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 });

});
