import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { loadConfig,configurationGaps } from './config.js';
import { Database } from './db.js';
import { clerkIdentity,localIdentity } from './auth.js';
import { CustomerWorkflows } from './customer-runtime.js';

if(existsSync('.env'))loadEnvFile('.env');
const config=loadConfig();
if(configurationGaps(config).length)throw Error('Configure the dedicated Flockletter worker before starting it.');
const db=new Database(config.databaseUrl!);
await db.verifyBoundary();
const runtime=new CustomerWorkflows(db,config,config.localIdentity?localIdentity():clerkIdentity(config));
const stop=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stop.abort();void runtime.close();});
try{await runtime.run(stop.signal);}
finally{await runtime.close();await db.close();}
