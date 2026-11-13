import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignupPostcard } from "../../shared/SignupPostcard.js";
import { buttonInk, type SignupDesign } from "../../shared/signup-design.js";

export function sendPostcard(
  res: Response,
  formId: string,
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
                    ? "/newsletter/" + encodeURIComponent(formId) + "/logo"
                    : undefined
                }
              >
                {body}
              </SignupPostcard>
            </main>
          </body>
        </html>,
      ),
  );
}
