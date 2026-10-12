import{describe,it,expect}from'vitest';
import{databaseTarget}from'../support/database-target';
describe('database test target gate',()=>{
 it('allows disposable local test database',()=>expect(databaseTarget({TEST_DATABASE_URL:'postgres://postgres@localhost/dental_test_task3'})).toBe('postgres://postgres@localhost/dental_test_task3'));
 it.each(['postgres://localhost/patients','https://localhost/dental_test_fake','postgres://localhost/dental_test_fake?host=evil.example','postgres://remote.example/dental_test_fake'])('refuses unsafe target%s',url=>expect(()=>databaseTarget({TEST_DATABASE_URL:url})).toThrow());
 it('fails without URL',()=>expect(()=>databaseTarget({})).toThrow());
 it('redacts malformed connection value',()=>{let error:unknown;try{databaseTarget({TEST_DATABASE_URL:'PRIVATE_SECRET_CANARY'});}catch(e){error=e;}expect(error).toBeInstanceOf(Error);expect(JSON.stringify(error)).not.toContain('PRIVATE_SECRET_CANARY');});
 const ref='abcdefghijklmnopqrst';const url=`postgres://postgres@db.${ref}.supabase.co/postgres`;
 it('requires explicit verified staging target and remote opt-in',()=>{expect(()=>databaseTarget({TEST_DATABASE_URL:url,TEST_SUPABASE_PROJECT_REF:ref})).toThrow();expect(databaseTarget({TEST_DATABASE_URL:url,TEST_SUPABASE_PROJECT_REF:ref,ALLOW_REMOTE_TEST_DATABASE:'true'})).toBe(url);});
 it('rejects mismatched project',()=>expect(()=>databaseTarget({TEST_DATABASE_URL:url,TEST_SUPABASE_PROJECT_REF:'zyxwvutsrqponmlkjihgf',ALLOW_REMOTE_TEST_DATABASE:'true'})).toThrow());
 it('does not turn remote opt-in into arbitrary remote access',()=>expect(()=>databaseTarget({TEST_DATABASE_URL:'postgres://elsewhere/postgres',ALLOW_REMOTE_TEST_DATABASE:'true'})).toThrow());
});
it('restricted migration harness wires both URLs through the tested connection-override guard before clients (source check)',async()=>{const{readFile}=await import('node:fs/promises');const source=await readFile('scripts/test-restricted-dispatch-migration.mjs','utf8');expect(source).toMatch(/for\(const url of \[operatorUrl,adminUrl\]\)\{\s*databaseTarget\(\{TEST_DATABASE_URL:url.href\}\);/);expect(source.indexOf('databaseTarget({TEST_DATABASE_URL:url.href})')).toBeLessThan(source.indexOf('new pg.Client'));});
it.each(['postgres://postgres@127.0.0.1:55459/dental_test_restricted?host=outside.invalid&port=5432&user=other','postgres://postgres@127.0.0.1:55459/dental_test_restricted#override','https://postgres@127.0.0.1:55459/dental_test_restricted'])('rejects driver override before any connection: %s',url=>expect(()=>databaseTarget({TEST_DATABASE_URL:url})).toThrow('Unsafe database test URL or connection override.'));
