/** Keep Resend send authority separate from its currently broader retrieval credential. */
export function supportResendKeys(env: NodeJS.ProcessEnv, live: boolean) {
  const sending=env.FLOCKLETTER_SUPPORT_RESEND_KEY?.trim();
  const retrieval=env.FLOCKLETTER_SUPPORT_RESEND_RETRIEVE_KEY?.trim();
  if(live && (!sending || !retrieval))
    throw Error('Live support requires separate sending and retrieval Resend credentials.');
  if(env.FLOCKLETTER_SUPPORT_NATIVE_WEBHOOK_SECRET && !retrieval)
    throw Error('Native support receiving requires its dedicated retrieval Resend credential.');
  if(sending && retrieval && sending===retrieval)
    throw Error('Use different Resend credentials for support sending and retrieval.');
  return {sending,retrieval};
}
