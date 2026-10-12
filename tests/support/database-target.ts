/** Environment flags identify a previously approved test target; they cannot grant consent. */
export function databaseTarget(env:Record<string,string|undefined>):string{
 const value=env.TEST_DATABASE_URL;if(!value)throw new Error('TEST_DATABASE_URL required; no PostgreSQL tests ran.');
 let url:URL;try{url=new URL(value);}catch{throw new Error('Invalid database test URL.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash)throw new Error('Unsafe database test URL or connection override.');
 if(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&/^\/dental_test_[a-zA-Z0-9_]+$/.test(url.pathname))return value;
 const ref=env.TEST_SUPABASE_PROJECT_REF;
 if(env.ALLOW_REMOTE_TEST_DATABASE==='true'&&ref&&/^[a-z0-9]{20}$/.test(ref)&&url.hostname===`db.${ref}.supabase.co`&&url.pathname==='/postgres'&&url.username==='postgres'&&(!url.port||url.port==='5432'))return value;
 throw new Error('Refusing target: use disposable local dental_test_* or the explicitly authorized exact Supabase staging reference.');
}
