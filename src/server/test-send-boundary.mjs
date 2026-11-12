import {createHash} from 'node:crypto';
// SHA-256 of the exact migration031 guard bodies; source and migration must promote together.
const expectedGuardDigests={"flockletter_customer_test_snapshot_guard": "6783471145041d7b1a053ef7f2344da109403f5538d9c79a3862ed12c0f359d4", "flockletter_customer_test_dispatch_guard": "0ee5ae0c67b4c666a6e7a1a6ab09ee5c50dfd00ac34fc0cf942fa1cf0b9157b4"};
const normalize=value=>String(value);
const expectedConstraint="(((purpose = 'broadcast'::text) AND (test_day IS NULL) AND (test_slot IS NULL) AND (test_admitted_at IS NULL)) OR ((purpose = 'test'::text) AND (selected = 1) AND (((test_day IS NULL) AND (test_slot IS NULL) AND (test_admitted_at IS NULL) AND (state = ANY (ARRAY['reviewed'::text, 'cancelled'::text])) AND (approved_at IS NULL) AND (reservation_key IS NULL)) OR ((test_day IS NOT NULL) AND (test_slot IS NOT NULL) AND ((test_slot >= 1) AND (test_slot <= 5)) AND (test_admitted_at IS NOT NULL) AND (test_day = ((test_admitted_at AT TIME ZONE 'UTC'::text))::date)))))";
const expectedPredicate="((purpose = 'test'::text) AND (test_day IS NOT NULL))";
/** Fail closed when code is promoted without the test-send schema or its rollback guards. */
export async function verifyTestSendBoundary(client) {
 const columns=(await client.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,
  pg_get_expr(d.adbin,d.adrelid) default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=to_regclass('public.customer_deliveries') AND NOT a.attisdropped AND a.attname=ANY(ARRAY['purpose','test_day','test_slot','test_admitted_at'])`)).rows;
 const types=new Map([['purpose','text'],['test_day','date'],['test_slot','smallint'],['test_admitted_at','timestamp with time zone']]);
 if(columns.length!==4||columns.some(c=>types.get(c.attname)!==c.type||c.attnotnull!==(c.attname==='purpose')||c.attname==='purpose'&&c.default_value!=="'broadcast'::text"))throw Error('Test-send purpose and admission columns require migration031.');
 const check=(await client.query(`SELECT convalidated,pg_get_expr(conbin,conrelid) expression FROM pg_constraint
  WHERE conrelid=to_regclass('public.customer_deliveries') AND conname='customer_test_send_snapshot' AND contype='c'`)).rows[0];
 if(!check?.convalidated||normalize(check.expression)!==normalize(expectedConstraint))throw Error('Test-send immutable snapshot admission constraints require migration031.');
 const index=(await client.query(`SELECT i.indisunique,i.indisvalid,i.indisready,i.indnatts,i.indnkeyatts,pg_get_expr(i.indpred,i.indrelid) predicate,
  ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.n) columns
  FROM pg_index i WHERE i.indexrelid=to_regclass('public.customer_test_send_daily_slots') AND i.indrelid=to_regclass('public.customer_deliveries') AND i.indexprs IS NULL`)).rows[0];
 if(!index?.indisunique||!index.indisvalid||!index.indisready||index.indnatts!==3||index.indnkeyatts!==3||JSON.stringify(index.columns)!==JSON.stringify(['workspace_id','test_day','test_slot'])||normalize(index.predicate)!==normalize(expectedPredicate))throw Error('Test-send daily admissions need their unique shared five-slot index.');
 const guards=(await client.query(`SELECT c.relname,t.tgname,p.proname,p.prosrc,p.prosecdef,p.proconfig=ARRAY['search_path=pg_catalog']::text[] fixed_path,
  p.proowner<>current_user::regrole::oid different_owner,
  NOT has_function_privilege(current_user,p.oid,'EXECUTE') runtime_cannot_execute,
  NOT EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') private_execute
  FROM pg_class c JOIN pg_trigger t ON t.tgrelid=c.oid JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE c.relnamespace='public'::regnamespace AND
  ((c.relname='customer_deliveries' AND t.tgname='flockletter_customer_test_snapshot_guard' AND p.oid=to_regprocedure('public.flockletter_customer_test_snapshot_guard()')) OR
   (c.relname='customer_delivery_recipients' AND t.tgname='flockletter_customer_test_dispatch_guard' AND p.oid=to_regprocedure('public.flockletter_customer_test_dispatch_guard()')))
  AND t.tgenabled='A' AND t.tgtype=23 AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector`)).rows;
 if(guards.length!==2||guards.some(g=>!g.prosecdef||!g.fixed_path||!g.different_owner||!g.runtime_cannot_execute||!g.private_execute||createHash('sha256').update(g.prosrc.replace(/\r\n/g,'\n')).digest('hex')!==expectedGuardDigests[g.proname]))throw Error('Test-send dispatch requires immutable migration-owned ALWAYS guards.');
 const selection=(await client.query(`SELECT a.attnotnull,format_type(a.atttypid,a.atttypmod) type,pg_get_expr(d.adbin,d.adrelid) default_value
  FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=to_regclass('public.customer_deliveries') AND a.attname='provider_revision' AND NOT a.attisdropped`)).rows[0];
 if(!selection?.attnotnull||selection.type!=='integer'||selection.default_value!=='0')throw Error('Provider selection requires migration033.');
 const providerGuard=(await client.query(`SELECT p.prosrc,p.prosecdef,p.proconfig=ARRAY['search_path=pg_catalog']::text[] fixed_path,
  p.proowner<>current_user::regrole::oid different_owner,
  NOT has_function_privilege(current_user,p.oid,'EXECUTE') runtime_cannot_execute,
  NOT EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') private_execute
  FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=to_regclass('public.customer_deliveries')
  AND t.tgname='flockletter_delivery_provider_snapshot_guard' AND p.oid=to_regprocedure('public.flockletter_delivery_provider_snapshot_guard()')
  AND t.tgenabled='A' AND t.tgtype=19 AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector`)).rows[0];
 if(!providerGuard?.prosecdef||!providerGuard.fixed_path||!providerGuard.different_owner||!providerGuard.runtime_cannot_execute||!providerGuard.private_execute||createHash('sha256').update(providerGuard.prosrc.replace(/\r\n/g,'\n')).digest('hex')!=='de6d1f75eb6f3a3470c605c99987533a2bbf99fd6608e3e499a5f542a5192083')throw Error('Provider reviews require the immutable migration033 guard.');

}
