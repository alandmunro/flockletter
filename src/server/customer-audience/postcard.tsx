import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignupPostcard } from "../../shared/SignupPostcard.js";
import { buttonInk, type SignupDesign } from "../../shared/signup-design.js";

export function sendPostcard(
  res: Response,
  formId: string | null,
  form: { brandName: string; design: SignupDesign },
  title: string,
  footer: string,
  body: ReactNode,
) {
  const nonce = randomBytes(18).toString("base64");
  res.set(
    "Content-Security-Policy",
    String(res.get("Content-Security-Policy")).replace(
      "style-src 'self'",
      "style-src 'self' 'nonce-" + nonce + "'",
    ),
  );
  // Legacy first-party links keep their confirmation token in a browser fragment.
  const fragmentAction = formId === null;
  const logoPath = formId === null ? "/subscriptions/confirmation-media/logo" : "/newsletter/" + encodeURIComponent(formId) + "/logo";
  const accent = form.design.accent;
  res.type("html").send(
    "<!doctype html>" +
      renderToStaticMarkup(
        <html lang="en">
          <head>
            <meta charSet="utf-8" />
            <meta
              name="viewport"
              content="width=device-width,initial-scale=1"
            />
            <title>
              {title + ' | ' + (form.design.displayName || form.brandName)}
            </title>
            <link rel="stylesheet" href="/signup-postcard.css" />
            {fragmentAction && <script src="/subscriber-action.js" defer />}
            <style nonce={nonce}>
              {".signup-postcard{--postcard-accent:" +
                accent +
                ";--postcard-ink:" +
                buttonInk(accent) +
                "}"}
            </style>
          </head>
          <body className="postcard-page">
            <main>
              <SignupPostcard
                design={form.design}
                brandName={form.brandName}
                title={title}
                footer={footer}
                logo={
                  form.design.logoId
                    ? logoPath
                    : undefined
                }
              >
                {body}
                {fragmentAction && <p id="status" role="status" />}
                {fragmentAction && <noscript>Enable JavaScript to use this confirmation form.</noscript>}
              </SignupPostcard>
            </main>
          </body>
        </html>,
      ),
  );
}

/**
 * FL-BRD-002: the compact form a brand's own website frames in a pop-up. The host page supplies the
 * heading and close control, so this page carries only the form, its consent wording and the result.
 * `status` lets /signup-embed.js tell the host page that a request was submitted; nothing personal is sent.
 */
export function sendEmbed(
  res: Response,
  form: { brandName: string; design: SignupDesign },
  status: "ready" | "submitted" | "error",
  body: ReactNode,
) {
  const nonce = randomBytes(18).toString("base64");
  res.set(
    "Content-Security-Policy",
    String(res.get("Content-Security-Policy")).replace(
      "style-src 'self'",
      "style-src 'self' 'nonce-" + nonce + "'",
    ),
  );
  const accent = form.design.accent;
  res.type("html").send(
    "<!doctype html>" +
      renderToStaticMarkup(
        <html lang="en">
          <head>
            <meta charSet="utf-8" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>{"Sign up | " + (form.design.displayName || form.brandName)}</title>
            <link rel="stylesheet" href="/signup-postcard.css" />
            <link rel="stylesheet" href="/signup-embed.css" />
            <script src="/signup-embed.js" defer />
            <style nonce={nonce}>
              {".signup-postcard{--postcard-accent:" + accent + ";--postcard-ink:" + buttonInk(accent) + "}"}
            </style>
          </head>
          <body className="embed-page" data-flockletter-status={status}>
            <main className="signup-postcard signup-embed">{body}</main>
          </body>
        </html>,
      ),
  );
}
