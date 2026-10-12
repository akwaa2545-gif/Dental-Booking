export type Membership={parent:string;member:string;admin_option:boolean;set_option:boolean|null;inherit_option:boolean|null;grantor_super:boolean};
export function assertMembershipBaseline(version:number,rows:Membership[]):void{
 const major=Math.floor(version/10000);
 if(major===15&&rows.length===0)return;
 if(major===17&&rows.length===2&&new Set(rows.map(r=>r.parent)).size===2&&rows.every(r=>['dental_backend','dental_function_owner'].includes(r.parent)&&r.member==='postgres'&&r.admin_option&&r.set_option===false&&r.inherit_option===false&&r.grantor_super))return;
 throw new Error('Unexpected managed role membership baseline');
}
