import{describe,it,expect}from'vitest';
import{assertMembershipBaseline}from'../support/managed-memberships';
const baseline=['dental_backend','dental_function_owner'].map(parent=>({parent,member:'postgres',admin_option:true,set_option:false,inherit_option:false,grantor_super:true}));
describe('managed membership acceptance',()=>{
 it('accepts no PG15 memberships',()=>expect(()=>assertMembershipBaseline(150019,[])).not.toThrow());
 it('rejects leftover PG15 migration membership',()=>expect(()=>assertMembershipBaseline(150019,[{...baseline[0],set_option:null,inherit_option:null}])).toThrow());
 it('accepts exactly the two PG17 creator-admin baselines',()=>expect(()=>assertMembershipBaseline(170011,baseline)).not.toThrow());
 it.each([[],[baseline[0]],[baseline[0],baseline[0]],baseline.map(r=>({...r,set_option:true})),baseline.map(r=>({...r,grantor_super:false}))].map(rows=>({rows})))('rejects malformed PG17 baseline',({rows})=>expect(()=>assertMembershipBaseline(170011,rows)).toThrow());
});
