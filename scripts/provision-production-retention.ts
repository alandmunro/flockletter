import {productionRetentionGrantSql,type ProductionRetentionKind,type ProductionRetentionPhase} from '../src/server/customer-retention/production-provision.js';

try {
 if(process.env.APP_ENV!=='production'||process.argv.length!==4)throw Error('Production kind and phase required.');
 process.stdout.write(productionRetentionGrantSql(process.argv[2] as ProductionRetentionKind,process.argv[3] as ProductionRetentionPhase));
} catch {
 process.stderr.write('Production retention SQL generation refused. Use APP_ENV=production, planner or executor, and role, database or objects phase.\n');
 process.exitCode=1;
}
