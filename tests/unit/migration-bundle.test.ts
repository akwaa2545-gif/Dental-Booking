import{describe,it,expect}from'vitest';
import{assembleMigration}from'../../scripts/migration-bundle';
describe('atomic migration assembly',()=>{
 it('wraps both fragments in one atomic DO statement without committing an outer transaction',()=>{const sql=assembleMigration(['CREATE TABLE example(id int);','SELECT 1;']);expect(sql).toMatch(/^DO \$task3_atomic/);expect(sql).toContain("pg_catalog.set_config('dental.migration_bundle', 'task3-managed-v1', true)");expect(sql).toContain('CREATE TABLE example(id int);');expect(sql).toContain('SELECT 1;');expect(sql).not.toMatch(/^COMMIT;/m);expect(sql).not.toMatch(/^BEGIN;/m);});
 it.each(['COMMIT;','BEGIN;','ROLLBACK;','END;','START TRANSACTION;','ABORT;','PREPARE TRANSACTION \'x\';'])('rejects nested transaction statement%s',bad=>{expect(()=>assembleMigration(['SELECT 1;'+bad,'SELECT 2;'])).toThrow('transaction');});
 it('does not mistake quoted bodies or comments for transaction control',()=>{expect(()=>assembleMigration(["CREATE FUNCTION x() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN RAISE NOTICE 'COMMIT;'; END; $body$;", "--COMMIT;\nSELECT 'ROLLBACK;'; /* BEGIN; */"])).not.toThrow();});
 it('avoids quoting-delimiter collisions',()=>{const sql=assembleMigration(["SELECT '$task3_fragment_0$ $task3_atomic_0$';",'SELECT 2;']);expect(sql).toMatch(/^DO \$task3_atomic_1\$/);expect(sql).toContain('EXECUTE $task3_fragment_1$');});
 it('requires exactly two nonempty fragments',()=>{expect(()=>assembleMigration([''])).toThrow();expect(()=>assembleMigration(['SELECT 1;',''])).toThrow();});
 it.each(["SELECT 'broken",'/* never ends','SELECT $body$broken'])('rejects unterminated SQL %s',sql=>{expect(()=>assembleMigration([sql,'SELECT 2;'])).toThrow();});
});
