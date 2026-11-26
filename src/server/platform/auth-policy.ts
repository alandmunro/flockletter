export type OperatorMfaPolicy='required'|'pre-revenue';

function hasLiveCustomerWorkflow(env:NodeJS.ProcessEnv):boolean {
  return env.FLOCKLETTER_CUSTOMER_BILLING==='stripe_live'||
    env.FLOCKLETTER_LIVE_BILLING_APPROVED==='true'||
    env.FLOCKLETTER_CUSTOMER_DELIVERY==='ses'||
    env.FLOCKLETTER_CUSTOMER_DELIVERY==='resend'||
    env.FLOCKLETTER_LIVE_MAILING_APPROVED==='true'||
    env.FLOCKLETTER_CUSTOMER_SUPPORT==='live'||
    env.FLOCKLETTER_SUPPORT_ACTIVATION_APPROVED==='true'||
    env.FLOCKLETTER_TEXTING==='live'||
    env.FLOCKLETTER_TEXTING_ACTIVATION_APPROVED==='true'||
    env.FLOCKLETTER_WORKSPACE_GIFTS==='live'||
    env.FLOCKLETTER_GIFT_DELIVERY==='live';
}

/** D-051 is an explicit pre-revenue exception, never an automatic MFA downgrade. */
export function operatorMfaPolicy(environment:string,env:NodeJS.ProcessEnv):OperatorMfaPolicy {
  const policy=env.FLOCKLETTER_OPERATOR_MFA_POLICY??'required';
  if(policy!=='required'&&policy!=='pre-revenue')throw Error('Use an explicit supported operator MFA policy.');
  if(policy==='pre-revenue'&&(environment!=='production'||
    (env.FLOCKLETTER_RETENTION_SIGNING_ENABLED??'off')!=='off'||
    (env.FLOCKLETTER_CUSTOMER_RETENTION??'off')!=='off'))
    throw Error('The temporary operator exception requires production with hosted retention and signing off.');
  if(policy==='pre-revenue'&&hasLiveCustomerWorkflow(env))
    throw Error('The temporary pre-revenue operator exception cannot be used with live billing, delivery, support, texting or gifting.');
  return policy;
}

export function currentFirstFactor(ages:unknown):ages is [number,number] {
  return Array.isArray(ages)&&ages.length===2&&typeof ages[0]==='number'&&Number.isFinite(ages[0])&&ages[0]>=0&&ages[0]<5&&
    typeof ages[1]==='number'&&Number.isFinite(ages[1])&&(ages[1]===-1||ages[1]>=0);
}
