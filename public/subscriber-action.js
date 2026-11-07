const form = document.querySelector('form');
const button = form.querySelector('button');
const status = document.getElementById('status');
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
button.disabled = !token;
if (!token) status.textContent = 'Open the original link in your email.';
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  try {
    const response = await fetch(location.pathname, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (response.ok) {
      status.textContent = location.pathname.endsWith('/confirm')
        ? 'Your subscription is confirmed.'
        : 'You are unsubscribed.';
      form.hidden = true;
    } else if (response.status === 410) {
      status.textContent = 'This link is invalid, expired or already used.';
    } else {
      status.textContent = 'This request could not finish. Please try again.';
      button.disabled = false;
    }
  } catch {
    status.textContent = 'Could not reach Flockletter. Please try again.';
    button.disabled = false;
  }
});
