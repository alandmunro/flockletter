import {z} from 'zod';

/** Validate before constructing live alert transport; sending authority cannot substitute for lookup. */
export function platformAlertsConfiguration(env:NodeJS.ProcessEnv,mode:'capture'|'live') {
  const activation=z.enum(['off','approved']).parse(env.FLOCKLETTER_PLATFORM_ALERTS_ENABLED??'off');
  if(activation==='off')return undefined;
  const sending=env.FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY?.trim();
  const retrieval=env.FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY?.trim();
  if(mode!=='live'||!sending||!retrieval||sending===retrieval)
    throw Error('Live alerts require a verified operator configuration and separate sending/retrieval transport credentials.');
  return {sending,retrieval,from:z.email().parse(env.FLOCKLETTER_PLATFORM_ALERT_FROM),
    to:z.email().parse(env.FLOCKLETTER_PLATFORM_ALERT_TO)};
}
