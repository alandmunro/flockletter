# Sign-up form on a brand's own website (D-064, FL-BRD-002)

A brand can show its Flockletter sign-up form in a pop-up on its own website.

## How it works

- The framed form is the brand's public sign-up address with `?embed=1`, for example `https://<flockletter host>/signup/<slug>?embed=1`.
- Only the brand's **consent source domain** may frame it: `https://<domain>` and `https://www.<domain>`. Set that domain in Audience settings to the website that will show the pop-up. Every other site, and every other Flockletter page, gets `frame-ancestors 'none'`.
- The page carries only the form, its consent wording, the optional texting fields and a one-line confirmation note. The host page supplies the heading and the close control.
- The form posts to Flockletter's own origin from inside the frame, so the existing origin checks, rate limits, policy version, confirmation mode and SMS consent rules apply unchanged. A post sent straight from the host site is still refused.
- Email sign-ups record the source `customer-embed-<mode>-signup`. Texting consent evidence is recorded exactly as on the hosted page.
- Refusals, such as changed consent wording, appear inside the frame with the form again.

## Messages to the host page

`/signup-embed.js` posts two messages to the parent window. Neither contains personal data.

| Message | When |
| --- | --- |
| `{ type: 'flockletter:height', height }` | On load and whenever the form's height changes |
| `{ type: 'flockletter:status', status }` | On load; `status` is `ready`, `submitted` or `error` |

A host page should accept these messages only when `event.origin` is the Flockletter host. A `submitted` status means a request was received, not that the address is confirmed.

## Host page example

```html
<iframe src="https://<flockletter host>/signup/<slug>?embed=1" title="Sign up" style="width:100%;border:0"></iframe>
<script>
  addEventListener('message', function (e) {
    if (e.origin !== 'https://<flockletter host>' || !e.data) return;
    if (e.data.type === 'flockletter:height') document.querySelector('iframe').style.height = e.data.height + 'px';
    if (e.data.type === 'flockletter:status' && e.data.status === 'submitted') { /* remember and close the pop-up */ }
  });
</script>
```

## Verification

Local route and database tests cover FL-AT-046. Framing in real browsers on the brand's website, staging and production remain to be checked after release.
