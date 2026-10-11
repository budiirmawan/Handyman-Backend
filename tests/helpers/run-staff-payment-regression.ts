import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
/** One-shot isolated runner for the legacy payment file (which expects external PG). */
async function main() {
  const dir=await mkdtemp(join(tmpdir(),'staff-payment-regression-'));
  const pg=new EmbeddedPostgres({databaseDir:dir,port:55517,user:'postgres',password:'',persistent:true,authMethod:'trust'});
  let started=false, exitCode=1;
  try {
    await pg.initialise();await pg.start();started=true;
    const code=await new Promise<number>((resolve,reject)=>{
      const child=spawn('./node_modules/.bin/tsx',['--test','--test-concurrency=1','tests/handyman-care-workspace-payment-report.test.ts'],{stdio:'inherit',env:{...process.env,NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:'55517',DB_USER:'postgres',DB_PASSWORD:'',DB_NAME:'staff_payment_'+randomUUID().replaceAll('-',''),DB_SSL:'false'}});
      child.on('error',reject);child.on('exit',code=>resolve(code??1));
    });
    exitCode=code;
  } finally {if(started) await pg.stop();await rm(dir,{recursive:true,force:true});}
  // Embedded PG teardown can alter process.exitCode: preserve the actual test result LAST.
  process.exitCode=exitCode;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
