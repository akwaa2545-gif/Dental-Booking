import{spawnSync}from'node:child_process';
import{databaseTarget}from'../tests/support/database-target.ts';
try{databaseTarget(process.env);}catch(error){console.error(error.message);process.exit(1);}
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.db.config.ts',...(process.argv.slice(2).length?process.argv.slice(2):['tests/db'])],{stdio:'inherit',env:process.env});
process.exit(result.status??1);
