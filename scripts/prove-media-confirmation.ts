import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { chromium, type Browser, type Page } from "playwright-core";
import { startDatabase } from "./database-fixture.js";
import { rejectOptionalCookies } from "./browser-cookie-choice.js";
import { Database } from "../src/server/db.js";
import { Authenticator, localIdentity } from "../src/server/auth.js";
import { CommandService, type Actor } from "../src/server/service.js";
import { CustomerWorkflows } from "../src/server/customer-runtime.js";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import type { Workspace, AssetSummary } from "../src/shared/contracts.js";

const root =
  process.env.FLOCKLETTER_MEDIA_SCREENSHOTS ??
  "/private/tmp/flockletter-media-confirmation-proof";
const actor: Actor = {
  kind: "session",
  workspaceId: "org_local_sample",
  userId: "local_owner",
  actorId: "user:local_owner",
  owner: true,
  brandIds: null,
  scopes: ["read"],
};
async function command(
  page: Page,
  name: string,
  action: () => Promise<unknown>,
) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/v1/commands/" + name,
    ),
    action(),
  ]);
  assert.equal(response.status(), 200, await response.text());
  return (await response.json()).result;
}
const fixture = await startDatabase(),
  db = new Database(fixture.url, 2),
  server = createServer();
let browser: Browser | undefined,
  customer: CustomerWorkflows | undefined,
  proofPage: Page | undefined;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = "http://127.0.0.1:" + address.port;
  const config = loadConfig({
    APP_ENV: "local",
    APP_ORIGIN: origin,
    LOCAL_TEST_IDENTITY: "true",
    DATABASE_URL: fixture.url,
  });
  const identity = localIdentity();
  customer = new CustomerWorkflows(db, config, identity, {
    APP_ENV: "local",
    FLOCKLETTER_CUSTOMER_AUDIENCE: "exercise",
  });
  const service = new CommandService(
    db,
    undefined,
    identity.isOwner,
    undefined,
    undefined,
    identity.team,
    undefined,
    undefined,
    undefined,
    "local",
    undefined,
    customer,
  );
  await service.execute(
    "workspace.initialize",
    {
      operationKey: randomUUID(),
      name: "Alpine Studio",
      brandName: "Alpine Notes",
    },
    actor,
  );
  const brand = (
    (await service.execute("workspace.get", {}, actor)) as Workspace
  ).brands[0]!.id;
  server.on(
    "request",
    createApp(config, service, new Authenticator(db, identity)),
  );
  browser = await chromium.launch({
    channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? "chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  proofPage = page;
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await rejectOptionalCookies(page);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("button", { name: "Image library", exact: true }).click();
  const raw = Buffer.from(
    Array.from({ length: 32 }, (_, i) =>
      i < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255],
    ).flat(),
  );
  const gif = await sharp(raw, {
    raw: { width: 4, height: 8, channels: 4, pageHeight: 4 },
  })
    .gif({ delay: [100, 200], loop: 0 })
    .toBuffer();
  await page
    .getByLabel("Add JPEG, PNG, GIF, WebP or SVG images")
    .setInputFiles([
      { name: "animation.gif", mimeType: "image/gif", buffer: gif },
      {
        name: "logo.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#ff6688"/></svg>',
        ),
      },
      {
        name: "unsafe.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
      },
    ]);
  const upload = (await command(page, "asset.uploadBatch", () =>
    page.getByRole("button", { name: "Upload 3 images", exact: true }).click(),
  )) as { results: { ok: boolean; asset?: AssetSummary }[] };
  assert.deepEqual(
    upload.results.map((item) => item.ok),
    [true, true, false],
  );
  await page
    .getByText("SVG converted to PNG for safe, compatible email display.", {
      exact: false,
    })
    .waitFor();
  assert.deepEqual(
    (await service.readAsset(actor, upload.results[0]!.asset!.id)).bytes,
    gif,
  );
  assert.equal(upload.results[1]!.asset!.name, "logo.png");
  await page.locator('.media-grid img[alt="logo.png"]').waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".media-grid img")]
        .length === 2 &&
      [...document.querySelectorAll<HTMLImageElement>(".media-grid img")].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  );
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: root + "/images-desktop.png" });
  await nav.getByRole("button", { name: "Audience", exact: true }).click();
  const section = page.locator(".audience-onboarding");
  await section.getByLabel("Consent version", { exact: true }).fill("v2");
  const wording =
    "Send me Alpine Notes newsletters. I can unsubscribe at any time.";
  await section
    .getByLabel("Consent shown next to the signup checkbox")
    .fill(wording);
  await section.getByLabel("Source website domain").fill("alpine.example.test");
  await section
    .getByLabel("Require email confirmation for new signups")
    .uncheck();
  await section.getByLabel("Enable this brand’s signup form").check();
  await command(page, "audienceOnboarding.configure", () =>
    section
      .getByRole("button", { name: "Save signup settings", exact: true })
      .click(),
  );
  const setupDetails = section
    .locator("details")
    .filter({
      has: page.getByText("1. Signup page and consent", { exact: true }),
    });
  await page.waitForFunction(() =>
    document
      .querySelector(".audience-onboarding")
      ?.textContent?.includes(
        "subscribe immediately, without email verification",
      ),
  );
  if (
    !(await setupDetails.evaluate((node) => (node as HTMLDetailsElement).open))
  )
    await setupDetails.locator("summary").click();
  const link = section.getByRole("link", { name: "Open signup page" });
  await link.waitFor();
  const form = await browser.newPage();
  await form.goto((await link.getAttribute("href"))!);
  await form
    .getByText("No email confirmation is required.", { exact: false })
    .waitFor();
  await form.getByLabel("Email address").fill("form@example.com");
  await form.getByLabel(wording, { exact: true }).check();
  await form.getByRole("button", { name: "Subscribe", exact: true }).click();
  await form
    .getByRole("heading", { name: "Request received", exact: true })
    .waitFor();
  await form.close();
  const importDetails = section
    .locator("details")
    .filter({ has: page.getByText("2. Import contacts", { exact: true }) });
  await importDetails.locator("summary").click();
  await importDetails
    .getByLabel("CSV with a header row")
    .setInputFiles({
      name: "permission.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("email\nimport@example.com"),
    });
  await importDetails.getByLabel("Email column").waitFor();
  await command(page, "audience.previewImport", () =>
    importDetails
      .getByRole("button", { name: "Preview import", exact: true })
      .click(),
  );
  await importDetails
    .getByLabel("How did these contacts give permission?", { exact: true })
    .fill("In-store import permission");
  await importDetails
    .getByLabel(
      "I have permission to contact these people on behalf of this brand.",
      { exact: true },
    )
    .check();
  await importDetails
    .getByLabel(
      "Subscribe imported contacts immediately without a confirmation email",
    )
    .check();
  await command(page, "audienceOnboarding.import", () =>
    importDetails
      .getByRole("button", {
        name: "Import and subscribe without email",
        exact: true,
      })
      .click(),
  );
  // Existing pending contacts use a separate explicit owner declaration.
  await service.execute(
    "audienceOnboarding.import",
    {
      operationKey: randomUUID(),
      brandId: brand,
      csvBase64: Buffer.from("email\npending@example.com").toString("base64"),
      emailColumn: 0,
      permissionAffirmed: true,
      source: "In-store permission",
    },
    actor,
  );
  await page.reload();
  await nav.getByRole("button", { name: "Audience", exact: true }).click();
  await section
    .getByText("Subscribe existing pending contacts without email", {
      exact: true,
    })
    .click();
  const pending = section
    .locator("details")
    .filter({
      has: page
        .locator("summary")
        .filter({ hasText: "Subscribe existing pending contacts" }),
    });
  await pending.getByLabel("pending@example.com", { exact: true }).check();
  await pending
    .getByLabel("Permission source for selected contacts")
    .fill("In-store signup");
  await pending
    .getByLabel(
      "I have permission to email these selected contacts for this brand.",
    )
    .check();
  await command(page, "audienceOnboarding.confirmContacts", () =>
    pending
      .getByRole("button", {
        name: "Subscribe 1 selected without email",
        exact: true,
      })
      .click(),
  );
  const rows = await db.brand(
    actor.workspaceId,
    brand,
    async (sql) =>
      (await sql.query<{ state: string }>("SELECT state FROM subscribers"))
        .rows,
  );
  assert.deepEqual(
    rows.map((row) => row.state),
    ["confirmed", "confirmed", "confirmed"],
  );
  assert.equal(
    await db.brand(
      actor.workspaceId,
      brand,
      async (sql) =>
        (await sql.query("SELECT FROM customer_audience_confirmations"))
          .rowCount,
    ),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: root + "/audience-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "GIF fidelity, safe SVG partial upload, single opt-in and explicit pending subscription passed desktop/mobile with disposable contacts and no external email.",
  );
} catch (error) {
  if (proofPage) {
    await mkdir(root, { recursive: true });
    await proofPage.screenshot({ path: root + "/failure.png" });
    console.error((await proofPage.locator("main").innerText()).slice(0, 9000));
  }
  throw error;
} finally {
  await browser?.close();
  await customer?.close();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  await fixture.stop();
}
