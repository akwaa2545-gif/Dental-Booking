/** Test-only cleanup: restore the original database clock even when fixture
 * row/session cleanup fails, and report every failed cleanup operation. */
export async function cleanupSessionFixture(steps:ReadonlyArray<()=>Promise<unknown>>,restore:()=>Promise<unknown>):Promise<void>{
 const failures:unknown[]=[];
 for(const step of steps){try{await step();}catch(error){failures.push(error);}}
 try{await restore();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(failures,'Disposable session fixture cleanup failed.');
}
