import {productionOperatorGrantSql,type ProductionOperatorPhase,type ProductionOperatorKind} from '../src/server/platform/production-provision.js';

try {
 if(process.env.APP_ENV!=='production'||![3,4].includes(process.argv.length))throw Error('Production phase required.');
 process.stdout.write(productionOperatorGrantSql(process.argv[2] as ProductionOperatorPhase,(process.argv[3]??'operator') as ProductionOperatorKind));
} catch {
 process.stderr.write('Production operator SQL generation refused. Use APP_ENV=production and role, database or objects phase, optionally followed by webOperator.\n');
 process.exitCode=1;
}
