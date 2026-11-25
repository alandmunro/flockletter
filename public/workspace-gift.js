(() => {
  window.addEventListener('hashchange', () => window.location.reload());
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fields = ['workspace', 'offer', 'token'];
  const identity = Object.fromEntries(fields.map((name) => [name, fragment.get(name)]));
  const sender = document.getElementById('sender');
  const details = document.getElementById('details');
  const status = document.getElementById('status');
  const claim = document.getElementById('claim');
  const check = document.getElementById('check');
  const reward = document.getElementById('reward');
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  let busy = false;

  function providerLink(value) {
    if (typeof value !== 'string') return null;
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const hosts = [
      'tremendous.com',
      'www.tremendous.com',
      'rewards.tremendous.com',
      'testflight.tremendous.com',
    ];
    return hosts.includes(url.hostname) ? url.href : null;
  }

  function present(offer, inspecting) {
    const expiry = new Date(offer.expiresAt);
    if (
      typeof offer.brand !== 'string' ||
      !offer.brand.trim() ||
      !Number.isSafeInteger(offer.face) ||
      offer.face <= 0 ||
      !offer.expiresAt ||
      Number.isNaN(expiry.getTime())
    ) {
      throw new Error('Unavailable offer');
    }
    sender.textContent = 'A thank-you from ' + offer.brand;
    details.textContent =
      money.format(offer.face / 100) +
      ' gift · Offer expires ' +
      expiry.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }) +
      '.';
    sender.hidden = details.hidden = false;
    switch (offer.state) {
      case 'offered':
        status.textContent =
          'Thank you for being part of our community. Claim your gift when you’re ready.';
        claim.hidden = !inspecting;
        check.hidden = inspecting;
        break;
      case 'claimed': {
        const href = providerLink(offer.rewardUrl);
        if (href) {
          reward.href = href;
          reward.hidden = false;
        }
        status.textContent = href
          ? 'Your gift has been claimed. Your reward is ready at Tremendous.'
          : 'Your gift has been claimed. Check again for your reward link.';
        check.hidden = Boolean(href);
        break;
      }
      case 'expired':
        status.textContent = 'This gift offer has expired.';
        break;
      case 'pending':
        status.textContent = 'Your claim is pending. Check again for your reward.';
        check.hidden = false;
        break;
      default:
        status.textContent = 'This gift is currently unavailable. Check again later.';
        check.hidden = false;
    }
  }

  async function show(action) {
    if (busy || (action === 'claim' && claim.hidden)) return;
    busy = true;
    const restoreFocus = document.activeElement === claim || document.activeElement === check;
    claim.hidden = check.hidden = reward.hidden = true;
    reward.removeAttribute('href');
    status.textContent = action === 'claim' ? 'Requesting your gift…' : 'Checking your offer…';
    try {
      const response = await fetch('/api/v1/workspace-gifts/' + action, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        mode: 'same-origin',
        referrerPolicy: 'origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(identity),
      });
      if (!response.ok) throw new Error('Offer unavailable');
      present(await response.json(), action === 'inspect');
    } catch {
      sender.hidden = details.hidden = true;
      status.textContent =
        action === 'claim'
          ? 'We couldn’t confirm your claim. Check gift status for the latest result.'
          : 'We couldn’t load this offer. Check again or reopen the original link.';
      check.hidden = false;
    } finally {
      busy = false;
      if (restoreFocus) [reward, claim, check].find((element) => !element.hidden)?.focus();
    }
  }

  if (fields.some((name) => !identity[name] || fragment.getAll(name).length !== 1)) {
    status.textContent = 'This gift link is incomplete. Open the original link from the sender.';
    return;
  }
  claim.addEventListener('click', () => void show('claim'));
  check.addEventListener('click', () => void show('inspect'));
  void show('inspect');
})();
