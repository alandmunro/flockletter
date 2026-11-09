import {productionOperatorGrantSql,type ProductionOperatorPhase} from '../src/server/platform/production-provision.js';

try {
 if(process.env.APP_ENV!=='production'||process.argv.length!==3)throw Error('Production phase required.');
 process.stdout.write(productionOperatorGrantSql(process.argv[2] as ProductionOperatorPhase));
} catch {
 process.stderr.write('Production operator SQL generation refused. Use APP_ENV=production and role, database or objects phase.\n');
 process.exitCode=1;
}
