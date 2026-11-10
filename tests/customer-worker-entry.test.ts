import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';

it.each([undefined,'embedded'])('refuses standalone startup with worker mode %s before opening the database',mode=>{
  const result=spawnSync(process.execPath,['--import','tsx','src/server/customer-worker-main.ts'],{
    cwd:process.cwd(),encoding:'utf8',timeout:15_000,
    env:{PATH:process.env.PATH,APP_ENV:'test',APP_ORIGIN:'http://127.0.0.1:4310',LOCAL_TEST_IDENTITY:'true',
      DATABASE_URL:'postgresql://unused:unused@127.0.0.1:1/unused',
      ...(mode?{FLOCKLETTER_CUSTOMER_WORKER:mode}:{})},
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('The standalone worker requires FLOCKLETTER_CUSTOMER_WORKER=dedicated.');
  expect(result.stderr).not.toMatch(/ECONNREFUSED|password authentication failed/);
});
