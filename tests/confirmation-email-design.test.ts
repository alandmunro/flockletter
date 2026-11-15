import { expect, it } from "vitest";
import {
  renderConfirmationPreview,
  renderVerificationEmail,
} from "../src/shared/confirmation-email.js";
import { defaultDesign, signupDesign } from "../src/shared/signup-design.js";

const links = {
  confirmUrl: "https://mail.example.test/confirm?t=private",
  unsubscribeUrl: "https://mail.example.test/opt-out?t=private",
};
const copy = {
  subject: "Join Alpine",
  heading: "Confirm <your> address",
  message: "Hello <reader>!\nOne more step.",
  button: "Join the crew",
};
const design = {
  ...defaultDesign,
  displayName: "Alpine & Co",
  confirmation: copy,
};
const media = { width: 880, height: 440 };

it("previews the confirmation copy, identity and photos with the real layout and inert actions", () => {
  const preview = renderConfirmationPreview(design, "Merchant", {
    logo: { ...media, url: "blob:https://app.example.test/example-id" },
    photo: { ...media, url: "data:image/png;base64,YQ==" },
  });
  const mail = renderVerificationEmail(
    {
      brandName: design.displayName,
      layout: "appreciation",
      confirmation: copy,
      logo: {
        ...media,
        alt: design.displayName,
        contentId: "verification-brand",
      },
      photo: { ...media, alt: "", contentId: "verification-photo" },
    },
    links,
  );
  for (const result of [preview, mail]) {
    expect(result.subject).toBe("Join Alpine");
    expect(result.html).toContain("Alpine &amp; Co");
    expect(result.html).toContain("Confirm &lt;your&gt; address");
    expect(result.html).toContain("Hello &lt;reader&gt;!<br>One more step.");
    expect(result.html).toContain("Join the crew</a>");
    expect(result.text).toContain(copy.message);
  }
  expect(mail.html).toContain('src="cid:verification-photo"');
  expect(mail.text).toContain(links.confirmUrl);
  expect(mail.html).toContain(links.unsubscribeUrl);
  expect(preview.html).toContain('src="data:image/png;base64,YQ=="');
  expect(preview.html).toContain(
    'src="blob:https://app.example.test/example-id"',
  );
  expect(preview.html).not.toMatch(/href=|src="cid:|preview\.invalid/);
});

it("retains the default email and rejects injected header lines or remote preview images", () => {
  const preview = renderConfirmationPreview(defaultDesign, "Flock");
  expect(preview.subject).toBe("Confirm your Flock subscription");
  expect(preview.html).toContain('src="/brand/newsletter-postage.png"');
  expect(preview.html).toContain("Confirm my subscription</a>");
  expect(
    signupDesign.safeParse({
      ...design,
      confirmation: { subject: "Test\r\nBcc: X" },
    }).success,
  ).toBe(false);
  expect(
    renderConfirmationPreview(design, "Alpine", {
      photo: { ...media, url: "https://tracker.example/pixel" },
    }).html,
  ).not.toContain("tracker.example");
});
