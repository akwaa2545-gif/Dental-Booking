import{readFile,mkdir,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{assembleMigration}from'./migration-bundle.ts';
const names=['001_private_schema.sql','002_identity_patients.sql'];
const sql=assembleMigration(await Promise.all(names.map(name=>readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'))));
const dir=new URL('../artifacts/',import.meta.url);await mkdir(dir,{recursive:true});
await writeFile(new URL('task3-managed-candidate.sql',dir),sql);
console.log(JSON.stringify({artifact:'artifacts/task3-managed-candidate.sql',sha256:createHash('sha256').update(sql).digest('hex'),applied:false}));
