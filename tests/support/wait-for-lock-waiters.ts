import {setTimeout as delay} from 'node:timers/promises';
export interface LockObservationPort{query(text:string,values?:unknown[]):Promise<{rows:{pid:number;blockers:number[]}[]}>;}

/** Observe actual server lock waits rather than relying on a fixed sleep. */
export async function waitForLockWaiters(control:LockObservationPort,pids:number[],blocker?:number):Promise<void>{
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  // Current-query information is cached within an open transaction, including
  // a fixture transaction holding the row/table barrier being observed.
  // https://www.postgresql.org/docs/17/monitoring-stats.html#MONITORING-STATS-VIEWS
  await control.query('select pg_catalog.pg_stat_clear_snapshot()');
  const{rows}=await control.query(`
   select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
   where pid = any($1::integer[]) and state = 'active' and wait_event_type = 'Lock'
  `,[pids]);
  if(rows.length===pids.length&&(blocker===undefined||rows.every(row=>row.blockers.includes(blocker))))return;
  await delay(10);
 }
 throw new Error(`Did not observe all ${pids.length} independent requests waiting on the intended PostgreSQL lock.`);
}
