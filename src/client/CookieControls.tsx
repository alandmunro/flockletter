import { useEffect, useRef, useState } from 'react';
import { COOKIE_PREFERENCE_KEY, COOKIE_PREFERENCE_MS, newCookieChoice, savedCookieChoice,
  type CookieChoice, type CookieDecision } from '../shared/cookie-consent.js';
import { CookieNotice } from './CookieNotice.js';
import './cookies.css';

const privacySignal = () => (navigator as Navigator & {globalPrivacyControl?:boolean}).globalPrivacyControl === true || navigator.doNotTrack === '1';

export function CookieControls() {
  const [choice,setChoice] = useState<CookieChoice|null>(null);
  const [open,setOpen] = useState(false);
  const [error,setError] = useState('');
  const [signal,setSignal] = useState(false);
  const [revision,setRevision] = useState(0);
  const [ready,setReady] = useState(false);
  const manualOpen=useRef(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>|undefined;
    const read = () => {
      if(disposed) return;
      clearTimeout(timer);
      let saved: CookieChoice|null = null;
      try {
        const raw=localStorage.getItem(COOKIE_PREFERENCE_KEY);
        saved=savedCookieChoice(raw);
        if(raw !== null && !saved) localStorage.removeItem(COOKIE_PREFERENCE_KEY);
      }
      catch { /* No persisted permission when browser storage cannot be read. */ }
      setChoice(saved);
      setReady(true);
      setSignal(privacySignal());
      setOpen(manualOpen.current || saved === null);
      if(saved) timer=setTimeout(read,Math.min(Math.max(1,saved.at+COOKIE_PREFERENCE_MS-Date.now()),2_147_483_647));
    };
    const storage = (event: StorageEvent) => {
      if(event.key === COOKIE_PREFERENCE_KEY || event.key === null) read();
    };
    const show = () => { manualOpen.current=true;read(); };
    queueMicrotask(read);
    window.addEventListener('storage',storage);
    window.addEventListener('focus',read);
    window.addEventListener('pageshow',read);
    document.addEventListener('visibilitychange',read);
    window.addEventListener('flockletter:cookie-choices',show);
    return () => {
      disposed=true;clearTimeout(timer);
      window.removeEventListener('storage',storage);
      window.removeEventListener('focus',read);
      window.removeEventListener('pageshow',read);
      document.removeEventListener('visibilitychange',read);
      window.removeEventListener('flockletter:cookie-choices',show);
    };
  },[revision]);

  function choose(decision: CookieDecision) {
    const saved=newCookieChoice(decision);
    setSignal(privacySignal());
    try {
      const raw=JSON.stringify(saved);
      localStorage.setItem(COOKIE_PREFERENCE_KEY,raw);
      if(localStorage.getItem(COOKIE_PREFERENCE_KEY)!==raw) throw Error('Preference not persisted.');
      setChoice(saved);setError('');close();setRevision(value=>value+1);
    } catch {
      manualOpen.current=true;
      setChoice(saved);setOpen(true);
      setError('Your browser could not save this choice. Optional cookies remain off. You can continue using Flockletter and try again later.');
    }
    // This operation never reloads the page, clears authentication storage or
    // changes a workspace/email preference. Existing campaign edits stay intact.
  }
  function close() {
    manualOpen.current=false;
    setOpen(false);
    document.querySelector<HTMLButtonElement>('.cookie-controls > button')?.focus();
  }
  return <div data-cookie-preferences-ready={ready}><CookieNotice open={open} decision={choice?.choice??null} error={error}
    onChoose={choose} onClose={close} signal={signal}/></div>;
}
