import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { loadConfig,configurationGaps } from './config.js';
import { Database } from './db.js';
import { platformRuntime } from './platform/runtime.js';
import { Authenticator,clerkIdentity,localIdentity } from './auth.js';
import {customerSettings} from './customer-settings.js';
import { CustomerWorkflows } from './customer-runtime.js';

if(existsSync('.env'))loadEnvFile('.env');
const config=loadConfig();
if(configurationGaps(config).length)throw Error('Configure the dedicated Flockletter worker before starting it.');
if(!customerSettings(config).dedicated)throw Error('The standalone worker requires FLOCKLETTER_CUSTOMER_WORKER=dedicated.');
const db=new Database(config.databaseUrl!);
await db.verifyBoundary();
if((await db.pool.query('SELECT public.flockletter_restore_blocked() blocked')).rows[0]?.blocked)throw Error('Restore quarantine blocks the worker.');
const identity=config.localIdentity?localIdentity():clerkIdentity(config);
const runtime=new CustomerWorkflows(db,config,identity);
await runtime.engine?.verify();
const platform=await platformRuntime(config,db,new Authenticator(db,identity,runtime.billing.options),runtime);
const stop=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stop.abort();void runtime.close();});
try{await runtime.run(stop.signal);}
finally{await runtime.close();await platform?.close();await db.close();}
