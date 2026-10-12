/** Removes quoted SQL and comments only for top-level transaction screening.
 * This is an assembly guard, not a SQL parser or a proof of migration safety. */
function statementHeads(sql:string):string[]{
  let clean='',i=0;
  while(i<sql.length){
    if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i);i=end<0?sql.length:end;clean+=' ';continue;}
    if(sql.startsWith('/*',i)){let depth=1;i+=2;while(i<sql.length&&depth){if(sql.startsWith('/*',i)){depth++;i+=2;}else if(sql.startsWith('*/',i)){depth--;i+=2;}else i++;}if(depth)throw new Error('Unterminated SQL comment');clean+=' ';continue;}
    const dollar=sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)?.[0];
    if(dollar){const end=sql.indexOf(dollar,i+dollar.length);if(end<0)throw new Error('Unterminated SQL body');i=end+dollar.length;clean+=' literal ';continue;}
    if(sql[i]==="'"||sql[i]==='"'){
      const quote=sql[i],escaped=quote==="'"&&/[eE]/.test(sql[i-1]??'')&&(i<2||!/[\w$]/.test(sql[i-2]));
      i++;let closed=false;
      while(i<sql.length){if(escaped&&sql[i]==='\\'){i+=2;continue;}if(sql[i]===quote){if(sql[i+1]===quote){i+=2;continue;}i++;closed=true;break;}i++;}
      if(!closed)throw new Error('Unterminated SQL quote');clean+=' literal ';continue;
    }
    clean+=sql[i++];
  }
  return clean.split(';').map(x=>x.trim()).filter(Boolean);
}
export function assembleMigration(fragments:string[]):string{
  if(fragments.length!==2||fragments.some(x=>!x.trim()))throw new Error('Exactly two nonempty migration fragments required');
  for(const fragment of fragments){
    for(const head of statementHeads(fragment)){
      if(/^(?:BEGIN|COMMIT|ROLLBACK|END|ABORT|START\s+TRANSACTION|PREPARE\s+TRANSACTION)\b/i.test(head))throw new Error('Nested transaction control is prohibited');
    }
  }
  const tag=(base:string,content:string)=>{let i=0;while(content.includes(`$${base}_${i}$`))i++;return `$${base}_${i}$`;};
  const commands=fragments.map(fragment=>{const delimiter=tag('task3_fragment',fragment);return `EXECUTE ${delimiter}${fragment.trim()}${delimiter};`;}).join('\n');
  const body="BEGIN\nPERFORM pg_catalog.set_config('dental.migration_bundle', 'task3-managed-v1', true);\n"+commands+'\nEND;';
  const outer=tag('task3_atomic',body);
  // One invoker DO statement is atomic even without an API-owned transaction.
  // Never COMMIT an outer transaction; any exception propagates and rolls back.
  return `DO ${outer}\n${body}\n${outer};\n`;
}
