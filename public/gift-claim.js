(() => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const body = JSON.stringify({
    workspace: fragment.get('workspace'),
    person: Number(fragment.get('person')),
    token: fragment.get('token'),
  });
  const button = document.getElementById('claim');
  const status = document.getElementById('status');
  if (location.pathname === '/gifts/reward') {
    const input = Object.fromEntries(fragment);
    input.person = Number(input.person);
    input.expires = Number(input.expires);
    void fetch('/api/v1/gifts/reward', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
      .then(async (response) => {
        if (!response.ok) throw Error('Reopen the original gift to refresh your reward link.');
        const { products } = await response.json();
        status.textContent = 'Choose from these simulated products. Store redemption is unobserved.';
        for (const name of products) {
          const li = document.createElement('li');
          li.textContent = name;
          document.getElementById('products').append(li);
        }
      })
      .catch((error) => {
        status.textContent = error.message;
      });
    return;
  }
  async function show(action) {
    button.disabled = true;
    try {
      const response = await fetch('/api/v1/gifts/' + action, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!response.ok)
        throw Error('This gift could not be loaded. Reopen the original link to try again.');
      const offer = await response.json();
      const messages = {
        offered: 'Available through lab day ' + offer.expires + '.',
        pending: 'Your claim is pending provider reconciliation.',
        expired: 'This offer has expired.',
        claimed: 'Your simulated reward was purchased.',
      };
      status.textContent = messages[offer.state];
      if (offer.reward) {
        const reward = document.getElementById('reward');
        reward.href = offer.reward.path;
        reward.hidden = false;
      }
      button.hidden = offer.state !== 'offered';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  button.addEventListener('click', () => void show('claim'));
  void show('inspect');
})();
