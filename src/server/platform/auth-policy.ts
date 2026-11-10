export type OperatorMfaPolicy='required'|'pre-revenue';

/** D-051 is an explicit pre-revenue exception, never an automatic MFA downgrade. */
export function operatorMfaPolicy(environment:string,env:NodeJS.ProcessEnv):OperatorMfaPolicy {
  const policy=env.FLOCKLETTER_OPERATOR_MFA_POLICY??'required';
  if(policy!=='required'&&policy!=='pre-revenue')throw Error('Use an explicit supported operator MFA policy.');
  if(policy==='pre-revenue'&&(environment!=='production'||
    (env.FLOCKLETTER_CUSTOMER_BILLING??'off')!=='off'||
    (env.FLOCKLETTER_BILLING_MODE??'off')!=='off'||
    (env.FLOCKLETTER_RETENTION_SIGNING_ENABLED??'off')!=='off'||
    (env.FLOCKLETTER_CUSTOMER_RETENTION??'off')!=='off'))
    throw Error('The pre-revenue operator exception requires production with billing, hosted retention and signing off. Restore MFA before paid activation.');
  return policy;
}

export function currentFirstFactor(ages:unknown):ages is [number,number] {
  return Array.isArray(ages)&&ages.length===2&&typeof ages[0]==='number'&&Number.isFinite(ages[0])&&ages[0]>=0&&ages[0]<5&&
    typeof ages[1]==='number'&&Number.isFinite(ages[1])&&(ages[1]===-1||ages[1]>=0);
}
