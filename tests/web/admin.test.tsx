import {describe,expect,it,vi} from 'vitest';
import {render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {Dashboard} from '../../src/web/admin/Dashboard';
import {DecisionDialog} from '../../src/web/admin/DecisionDialog';
import {DateControls} from '../../src/web/admin/DateControls';
import {ApiRequestError,type ApiClient} from '../../src/web/api';
import type {Appointment} from '../../src/shared/contracts';
const now=()=>new Date('2026-10-08T03:00:00Z');
function item(id:string,createdAt:string,status:Appointment['status']='pending'):Appointment{return{id,reference:`SYNTHETIC-${id}`,patientId:id,patient:{fullName:`Synthetic ${id}`,phone:'0000000000',address:'Fictional address',age:25,relationship:'self',authorizationAcknowledged:true},service:'scaling',date:'2026-10-09',status,version:1,createdAt,approvedAt:null,cancelBefore:'2026-10-08T17:00:00Z'};}
function api(items:Appointment[]):ApiClient{return{dataMode:'server',async request<T>(path:string){return (path==='/api/availability'?[{date:'2026-10-09',state:'full'}]:items) as T;}};}
describe('reviewed admin screens',()=>{
 it('uses server copy, pending/default open date and oldest-first order with safe attempt summaries',async()=>{
 const client=api([{...item('new','2026-10-08T02:00:00Z'),notificationAttempts:[{kind:'approval',state:'queued',attemptCount:2}]},item('old','2026-10-07T02:00:00Z'),item('approved','2026-10-07T01:00:00Z','approved')] as Appointment[]);
 render(<Dashboard api={client} now={now}/>);
 expect(await screen.findByRole('heading',{name:'จัดการนัดหมาย'})).toBeVisible();
 await waitFor(()=>expect(screen.getAllByRole('article')).toHaveLength(2));
 expect(within(screen.getAllByRole('article')[0]).getByText('Synthetic old')).toBeVisible();
 expect(screen.getByText(/พยายามส่ง 2 ครั้ง/)).toBeVisible();
 expect(screen.queryByText(/สวิตช์นี้ใช้สาธิต/)).not.toBeInTheDocument();
 expect(screen.getByLabelText('สถานะคำขอ')).toHaveValue('pending');
 expect(screen.getByLabelText('วันที่นัด')).toHaveValue('2026-10-09');
 expect(within(screen.getByRole('region',{name:'คำขอและนัดที่ยังต้องจัดการ'})).getByText('Synthetic approved')).toBeVisible();
 });
 it('starts a server decision with an empty required reason and blocks repeat writes/editing',async()=>{
 let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});const confirm=vi.fn(()=>pending);const user=userEvent.setup();
 render(<DecisionDialog appointment={item('one','2026-10-08T00:00:00Z')} onConfirm={confirm} onClose={()=>{}} dataMode="server"/>);
 expect(screen.getByRole('dialog',{name:'พิจารณานัดหมาย'})).toBeVisible();
 const reason=screen.getByLabelText('เหตุผล');expect(reason).toHaveValue('');
 expect(screen.getByRole('button',{name:'อนุมัติคำขอ'})).toBeDisabled();
 await user.type(reason,'ตรวจสอบแล้ว');await user.dblClick(screen.getByRole('button',{name:'อนุมัติคำขอ'}));
 expect(confirm).toHaveBeenCalledTimes(1);expect(reason).toBeDisabled();finish();
 await waitFor(()=>expect(reason).not.toBeDisabled());
 });
 it('prevents editing a day-off operation while waiting and requires a deliberate server reason',async()=>{
 let finish!:(v:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});const user=userEvent.setup();
 const client:ApiClient={dataMode:'server',request:()=>pending as Promise<never>};
 render(<DateControls api={client} date="2026-10-09" unresolved={[]} onChanged={async()=>{}}/>);
 const reason=screen.getByLabelText('เหตุผลการเปลี่ยนแปลง');expect(reason).toHaveValue('');
 await user.type(reason,'ทันตแพทย์หยุด');await user.click(screen.getByRole('button',{name:'บันทึกการรับคำขอ'}));
 expect(reason).toBeDisabled();expect(screen.getByLabelText('การรับคำขอ')).toBeDisabled();finish({});
 await waitFor(()=>expect(reason).not.toBeDisabled());
 });
 it('clears private queue and closes stale review if authorization is revoked during mutation',async()=>{
 const client=api([item('one','2026-10-08T00:00:00Z')]);const read=client.request;let revoked=false;
 client.request=async<T,>(path:string,init?:RequestInit):Promise<T>=>{if(init?.method==='POST'){revoked=true;throw new ApiRequestError('FORBIDDEN',403);}if(revoked)throw new ApiRequestError('FORBIDDEN',403);return read<T>(path,init);};
 const user=userEvent.setup();render(<Dashboard api={client} now={now}/>);
 await user.click(await screen.findByRole('button',{name:'พิจารณาคำขอ'}));
 await user.type(screen.getByLabelText('เหตุผล'),'ตรวจสอบแล้ว');await user.click(screen.getByRole('button',{name:'อนุมัติคำขอ'}));
 await waitFor(()=>expect(screen.queryByText('Synthetic one')).not.toBeInTheDocument());
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByRole('alert')).toBeVisible();
 });
 it('refreshes a conflicting decision to the current state instead of offering another approval',async()=>{
 const original=item('one','2026-10-08T00:00:00Z');const client=api([original]);const read=client.request;let changed=false;
 client.request=async<T,>(path:string,init?:RequestInit):Promise<T>=>{if(init?.method==='POST'){changed=true;throw new ApiRequestError('VERSION_CONFLICT',409);}if(path==='/api/admin/appointments'&&changed)return [{...original,status:'approved',version:2}] as T;return read<T>(path,init);};
 const user=userEvent.setup();render(<Dashboard api={client} now={now}/>);
 await user.click(await screen.findByRole('button',{name:'พิจารณาคำขอ'}));await user.type(screen.getByLabelText('เหตุผล'),'ตรวจสอบแล้ว');await user.click(screen.getByRole('button',{name:'อนุมัติคำขอ'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('สถานะเปลี่ยนแล้ว');
 expect(within(screen.getByRole('dialog')).getByText('✓ อนุมัติแล้ว')).toBeVisible();
 expect(screen.queryByRole('button',{name:'อนุมัติคำขอ'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'บันทึกรับบริการแล้ว'})).toBeVisible();
 });
 it('failed closure keeps every active booking visible and never silently cancels or rejects it',async()=>{
 const user=userEvent.setup();const record=item('approved','2026-10-07T00:00:00Z','approved');const paths:string[]=[];
 const client:ApiClient={dataMode:'server',async request(path:string){paths.push(path);throw new ApiRequestError('UNRESOLVED_BOOKINGS',409);}};
 render(<DateControls api={client} date="2026-10-09" unresolved={[record]} onChanged={async()=>{}}/>);
 await user.selectOptions(screen.getByLabelText('การรับคำขอ'),'closed');await user.type(screen.getByLabelText('เหตุผลการเปลี่ยนแปลง'),'หยุดทำการ');await user.click(screen.getByRole('button',{name:'บันทึกการรับคำขอ'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('ยังปิดวันไม่ได้');
 expect(screen.getByText('Synthetic approved')).toBeVisible();expect(screen.getByText('✓ อนุมัติแล้ว')).toBeVisible();
 expect(paths).toEqual(['/api/admin/dates/2026-10-09']);
 expect(screen.queryByRole('button',{name:'ไม่อนุมัติคำขอ'})).not.toBeInTheDocument();
 });

 it('clears the private queue when a date intake mutation loses authorization',async()=>{
 const client=api([item('one','2026-10-08T00:00:00Z')]);const read=client.request;
 client.request=async<T,>(path:string,init?:RequestInit):Promise<T>=>{if(init?.method==='PUT')throw new ApiRequestError('FORBIDDEN',403);return read<T>(path,init);};
 const user=userEvent.setup();render(<Dashboard api={client} now={now}/>);
 await screen.findByRole('button',{name:'พิจารณาคำขอ'});
 await user.type(screen.getByLabelText('เหตุผลการเปลี่ยนแปลง'),'หยุดทำการ');await user.click(screen.getByRole('button',{name:'บันทึกการรับคำขอ'}));
 await waitFor(()=>expect(screen.queryAllByText('Synthetic one')).toHaveLength(0));
 expect(screen.queryByRole('button',{name:'พิจารณาคำขอ'})).not.toBeInTheDocument();expect(screen.getByRole('alert')).toBeVisible();
 });

 it('refreshes new unresolved bookings when close loses a race with a reservation',async()=>{
 const client=api([]);const read=client.request;let conflicted=false;
 client.request=async<T,>(path:string,init?:RequestInit):Promise<T>=>{if(init?.method==='PUT'){conflicted=true;throw new ApiRequestError('UNRESOLVED_BOOKINGS',409);}if(path==='/api/admin/appointments'&&conflicted)return [item('new','2026-10-08T00:00:00Z')] as T;return read<T>(path,init);};
 const user=userEvent.setup();render(<Dashboard api={client} now={now}/>);
 await screen.findByText('0/3 ที่ใช้ในวันที่เลือก');
 await user.selectOptions(await screen.findByLabelText('การรับคำขอ'),'closed');await user.type(screen.getByLabelText('เหตุผลการเปลี่ยนแปลง'),'หยุดทำการ');await user.click(screen.getByRole('button',{name:'บันทึกการรับคำขอ'}));
 expect(await screen.findByText('1/3 ที่ใช้ในวันที่เลือก')).toBeVisible();
 expect(within(screen.getByRole('region',{name:'คำขอและนัดที่ยังต้องจัดการ'})).getByText('Synthetic new')).toBeVisible();
 expect(screen.getByRole('alert')).toHaveTextContent('ยังปิดวันไม่ได้');
 });
 it('honors a known decision denial even if later reads would be unavailable',async()=>{
 const client=api([item('one','2026-10-08T00:00:00Z')]);const read=client.request;let denied=false;let privateReads=0;
 client.request=async<T,>(path:string,init?:RequestInit):Promise<T>=>{if(init?.method==='POST'){denied=true;throw new ApiRequestError('FORBIDDEN',403);}if(path==='/api/admin/appointments')privateReads++;if(denied)throw new ApiRequestError('UNAVAILABLE',503);return read<T>(path,init);};
 const user=userEvent.setup();render(<Dashboard api={client} now={now}/>);
 await user.click(await screen.findByRole('button',{name:'พิจารณาคำขอ'}));await user.type(screen.getByLabelText('เหตุผล'),'ตรวจสอบแล้ว');await user.click(screen.getByRole('button',{name:'อนุมัติคำขอ'}));
 await waitFor(()=>expect(screen.queryAllByText('Synthetic one')).toHaveLength(0));
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByRole('alert')).toHaveTextContent('ไม่มีสิทธิ์');expect(privateReads).toBe(1);
 });

});
