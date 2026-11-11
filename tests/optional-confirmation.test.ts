import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { startDatabase } from "../scripts/database-fixture.js";
import { Database } from "../src/server/db.js";
import {
  CommandService,
  authorize,
  type Actor,
} from "../src/server/service.js";
import {
  CustomerAudience,
  productionConsentEligible,
  productionConsentEligibleBatch,
  createCustomerOptOut,
  redeemCustomerOptOut,
} from "../src/server/customer-audience/service.js";
import type { AudienceSettingsView } from "../src/shared/customer-audience.js";
import { makeAudienceConnection } from "./helpers/audience-connection.js";
import { customerAudienceCommands } from "../src/shared/customer-audience.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/bridge.js";

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
async function setup(mode: "exercise" | "live" = "exercise", maximum = 250) {
  const w = "org_" + randomUUID().replaceAll("-", "");
  const owner: Actor = {
    workspaceId: w,
    userId: "user_owner",
    actorId: "user:owner",
    kind: "session",
    owner: true,
    scopes: ["read"],
    brandIds: null,
  };
  const core = new CommandService(db);
  await core.execute(
    "workspace.initialize",
    { operationKey: randomUUID(), name: "Consent test", brandName: "Alpine" },
    owner,
  );
  const brand = (
    (await core.execute("workspace.get", {}, owner)) as {
      brands: { id: string }[];
    }
  ).brands[0]!.id;
  let currentOwner = true;
  const audience = new CustomerAudience(db, {
    mode,
    origin: "https://mail.example.test",
    checkOwner: async () => currentOwner,
    contactLimit: async () => maximum,
  });
  const configuration = {
    brandId: brand,
    enabled: true,
    purpose: "alpine_news",
    policyVersion: "v1",
    consentText: "Send me Alpine newsletters. I can unsubscribe anytime.",
    sourceDomain: "alpine.example.test",
  };
  const configure = (patch: Record<string, unknown> = {}) =>
    audience.execute(
      "audienceOnboarding.configure",
      { ...configuration, operationKey: randomUUID(), ...patch },
      owner,
    );
  await configure();
  const status = () =>
    audience.execute(
      "audienceOnboarding.status",
      { brandId: brand },
      owner,
    ) as Promise<AudienceSettingsView>;
  const form = (await status()).publicUrl!.split("/newsletter/")[1]!;
  const signup = (
    email: string,
    version = "v1",
    extra: Record<string, unknown> = {},
  ) =>
    audience.publicSignup(form, {
      email,
      policyVersion: version,
      consentAffirmed: true,
      ...extra,
    });
  const importContacts = (csv: string, extra: Record<string, unknown> = {}) =>
    audience.execute(
      "audienceOnboarding.import",
      {
        brandId: brand,
        operationKey: randomUUID(),
        csvBase64: Buffer.from(csv).toString("base64"),
        emailColumn: 0,
        permissionAffirmed: true,
        source: "In-store permission",
        ...extra,
      },
      owner,
    ) as Promise<{ rows: { outcome: string; subscriberId: string }[] }>;
  const contacts = () =>
    db.brand(
      w,
      brand,
      async (sql) =>
        (
          await sql.query<{
            id: string;
            state: string;
            email_normalized: string;
          }>(
            "SELECT id,state,email_normalized FROM subscribers ORDER BY email_normalized",
          )
        ).rows,
    );
  const confirm = (
    ids: string[],
    patch: Record<string, unknown> = {},
    actor = owner,
  ) =>
    audience.execute(
      "audienceOnboarding.confirmContacts",
      {
        brandId: brand,
        operationKey: randomUUID(),
        subscriberIds: ids,
        permissionAffirmed: true,
        source: "Signed in-store newsletter consent",
        policyVersion: "v1",
        ...patch,
      },
      actor,
    );
  return {
    w,
    owner,
    core,
    brand,
    audience,
    configuration,
    configure,
    status,
    form,
    signup,
    importContacts,
    contacts,
    confirm,
    revokeOwner: () => {
      currentOwner = false;
    },
  };
}
it("keeps double opt-in by default; changing mode needs a new policy and does not convert existing pending contacts", async () => {
  const a = await setup();
  await a.signup("pending@example.com");
  expect(await a.status()).toMatchObject({
    confirmationMode: "double_opt_in",
    messages: [{ state: "captured" }],
  });
  await expect(
    a.configure({ confirmationMode: "single_opt_in" }),
  ).rejects.toMatchObject({ code: "policy_version_required" });
  await a.configure({ confirmationMode: "single_opt_in", policyVersion: "v2" });
  expect((await a.contacts())[0]?.state).toBe("pending");
  await expect(a.signup("new@example.com", "v1")).rejects.toMatchObject({
    code: "consent_changed",
  });
  await a.signup("new@example.com", "v2");
  expect((await a.contacts()).map((x) => x.state)).toEqual([
    "confirmed",
    "pending",
  ]);
  expect((await a.status()).messages).toHaveLength(1);
  // Older clients that omit the new setting preserve the explicitly chosen mode.
  await a.configure({ policyVersion: "v2" });
  expect((await a.status()).confirmationMode).toBe("single_opt_in");
});
it("single opt-in needs affirmative consent, preserves all suppression, and never queues email or reveals recipient status", async () => {
  const a = await setup("live");
  await a.configure({ confirmationMode: "single_opt_in", policyVersion: "v2" });
  await expect(
    a.signup("new@example.com", "v2", { consentAffirmed: false }),
  ).rejects.toMatchObject({ code: "consent_required" });
  const first = await a.signup("new@example.com", "v2");
  expect(first).toEqual(await a.signup("new@example.com", "v2"));
  for (const state of ["unsubscribed", "hard_bounced", "complained"]) {
    await db.brand(a.w, a.brand, (sql) =>
      sql.query(
        "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,$5)",
        [a.w, a.brand, randomUUID(), state + "@example.com", state],
      ),
    );
    expect(await a.signup(state + "@example.com", "v2")).toEqual(first);
  }
  expect((await a.contacts()).map((x) => x.state).sort()).toEqual([
    "complained",
    "confirmed",
    "hard_bounced",
    "unsubscribed",
  ]);
  expect((await a.status()).messages).toEqual([]);
  const person = (await a.contacts()).find((x) => x.state === "confirmed")!;
  const event = await db.brand(
    a.w,
    a.brand,
    async (sql) =>
      (
        await sql.query(
          "SELECT source,evidence_source,recorded_by FROM subscriber_consent_events WHERE subscriber_id=$1 AND event='confirmed'",
          [person.id],
        )
      ).rows,
  );
  expect(event).toEqual([
    {
      source: "customer-live-single-opt-in",
      evidence_source: "customer-public-live-signup",
      recorded_by: "subscriber-form",
    },
  ]);
  const opt = await db.brand(a.w, a.brand, (sql) =>
    createCustomerOptOut(
      sql,
      a.w,
      a.brand,
      person.id,
      "https://mail.example.test",
    ),
  );
  await redeemCustomerOptOut(db, new URL(opt.url).searchParams.get("t")!);
  await a.signup("new@example.com", "v2");
  expect((await a.contacts()).find((x) => x.id === person.id)?.state).toBe(
    "unsubscribed",
  );
});
it("permission imports subscribe only eligible contacts, preserve row results and capacity, and replay without duplicate evidence", async () => {
  const a = await setup("live", 2);
  await a.importContacts("email\npending@example.com");
  await db.brand(a.w, a.brand, (sql) =>
    sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'stopped@example.com','unsubscribed')",
      [a.w, a.brand, randomUUID()],
    ),
  );
  const input = {
    confirmWithoutEmail: true,
    consentPolicyVersion: "v1",
    operationKey: randomUUID(),
  };
  const csv =
    "email\npending@example.com\nnew@example.com\nnew@example.com\nstopped@example.com\nextra@example.com";
  const result = await a.importContacts(csv, input);
  expect(result.rows.map((x) => x.outcome)).toEqual([
    "subscribed_without_email",
    "subscribed_added",
    "duplicate",
    "kept_unsubscribed",
    "contact_limit",
  ]);
  expect(await a.importContacts(csv, input)).toEqual(result);
  expect(
    await db.brand(
      a.w,
      a.brand,
      async (sql) =>
        (
          await sql.query(
            "SELECT count(*)::int n FROM subscriber_consent_events WHERE event='confirmed'",
          )
        ).rows[0]?.n,
    ),
  ).toBe(2);
  await expect(
    a.importContacts("email\na@example.com", { confirmWithoutEmail: true }),
  ).rejects.toMatchObject({ code: "consent_changed" });
  expect((await a.status()).messages).toEqual([]);
});
it("selected confirmation is explicit, scoped, audited and idempotent; it cannot reactivate suppression or another brand", async () => {
  const a = await setup("live"),
    b = await setup("live");
  const imported = await a.importContacts(
    "email\na@example.com\nb@example.com",
  );
  const foreign = (await b.importContacts("email\nforeign@example.com"))
    .rows[0]!.subscriberId;
  await a.core.execute(
    "audience.unsubscribe",
    { brandId: a.brand, id: imported.rows[1]!.subscriberId },
    a.owner,
  );
  const ids = [...imported.rows.map((x) => x.subscriberId), foreign];
  await expect(a.confirm(ids, { permissionAffirmed: false })).rejects.toThrow();
  await expect(a.confirm(ids, { policyVersion: "old" })).rejects.toMatchObject({
    code: "consent_changed",
  });
  const key = randomUUID(),
    result = await a.confirm(ids, { operationKey: key });
  expect(result).toMatchObject({
    emailVerificationPerformed: false,
    results: [
      { outcome: "subscribed_without_email" },
      { outcome: "kept_unsubscribed" },
      { outcome: "unavailable" },
    ],
  });
  expect(await a.confirm(ids, { operationKey: key })).toEqual(result);
  await expect(
    a.confirm(ids, { operationKey: key, source: "Changed permission" }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  expect((await b.contacts())[0]?.state).toBe("pending");
  const detail = await a.core.execute(
    "audience.contact",
    { brandId: a.brand, id: ids[0] },
    a.owner,
  );
  expect(detail).toMatchObject({
    events: [
      {
        source: "customer-live-owner-attestation",
        evidenceSource: "Signed in-store newsletter consent",
        recordedBy: "user:owner",
      },
    ],
  });
  a.revokeOwner();
  await expect(a.confirm([ids[0]!])).rejects.toMatchObject({
    code: "owner_required",
  });
});
it("does not let existing write grants confirm contacts or promote imports, including forged actors and revoked new grants", async () => {
  const a = await setup("live"),
    id = (await a.importContacts("email\np@example.com")).rows[0]!.subscriberId;
  const old = await makeAudienceConnection(db, a.owner, [a.brand]);
  await expect(a.confirm([id], {}, old.actor)).rejects.toMatchObject({
    code: "scope_required",
  });
  const input = {
    brandId: a.brand,
    operationKey: randomUUID(),
    csvBase64: Buffer.from("email\nx@example.com").toString("base64"),
    emailColumn: 0,
    permissionAffirmed: true,
    source: "Approved list",
    confirmWithoutEmail: true,
    consentPolicyVersion: "v1",
  };
  await expect(
    a.audience.execute("audienceOnboarding.import", input, old.actor),
  ).rejects.toMatchObject({ code: "scope_required" });
  await expect(
    a.confirm(
      [id],
      {},
      { ...old.actor, scopes: ["audience:write", "audience:confirm"] },
    ),
  ).rejects.toMatchObject({ code: "scope_required" });
  const grant = await makeAudienceConnection(
    db,
    a.owner,
    [a.brand],
    ["audience:confirm"],
  );
  expect(() =>
    authorize(grant.actor, "audienceOnboarding.confirmContacts"),
  ).not.toThrow();
  await db.tenant(a.w, (sql) =>
    sql.query("UPDATE connections SET revoked_at=now() WHERE id=$1", [
      grant.id,
    ]),
  );
  await expect(a.confirm([id], {}, grant.actor)).rejects.toMatchObject({
    code: "scope_required",
  });
});
it("exposes confirmation to MCP under the same explicit grant without letting that grant change signup policy", async () => {
  const a = await setup("live"),
    id = (await a.importContacts("email\np@example.com")).rows[0]!.subscriberId;
  const grant = await makeAudienceConnection(
    db,
    a.owner,
    [a.brand],
    ["audience:confirm"],
  );
  const bridge = createMcpServer(async (name, input) => {
    authorize(grant.actor, name as Parameters<typeof authorize>[1]);
    return a.audience.execute(name, input, grant.actor);
  });
  const client = new Client({ name: "consent-contract", version: "1" }),
    [transport, peer] = InMemoryTransport.createLinkedPair();
  await bridge.connect(transport);
  await client.connect(peer);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("audienceOnboarding_confirmContacts");
    expect(names).not.toContain("audienceOnboarding_configure");
    const result = await client.callTool({
      name: "audienceOnboarding_confirmContacts",
      arguments: {
        brandId: a.brand,
        operationKey: randomUUID(),
        subscriberIds: [id],
        permissionAffirmed: true,
        source: "Paper signup",
        policyVersion: "v1",
      },
    });
    expect(result.isError).not.toBe(true);
    expect((await a.contacts())[0]?.state).toBe("confirmed");
  } finally {
    await client.close();
    await bridge.close();
  }
});
it("keeps exercise auto-confirmation ineligible for production until separate live permission is recorded", async () => {
  const a = await setup();
  await a.configure({ confirmationMode: "single_opt_in", policyVersion: "v2" });
  await a.signup("p@example.com", "v2");
  const id = (await a.contacts())[0]!.id;
  expect(
    await db.brand(a.w, a.brand, (sql) => productionConsentEligible(sql, id)),
  ).toBe(false);
  expect(
    await db.brand(a.w, a.brand, (sql) =>
      productionConsentEligibleBatch(sql, [id]),
    ),
  ).toEqual([]);
  const live = new CustomerAudience(db, {
    mode: "live",
    origin: "https://mail.example.test",
    checkOwner: async () => true,
  });
  await live.execute(
    "audienceOnboarding.confirmContacts",
    {
      brandId: a.brand,
      operationKey: randomUUID(),
      subscriberIds: [id],
      permissionAffirmed: true,
      source: "Separate live permission",
      policyVersion: "v2",
    },
    a.owner,
  );
  expect(
    await db.brand(a.w, a.brand, (sql) =>
      productionConsentEligibleBatch(sql, [id]),
    ),
  ).toEqual([id]);
});
it("serializes concurrent confirmation so consent is recorded once and bounds batches", async () => {
  const a = await setup("live"),
    id = (await a.importContacts("email\np@example.com")).rows[0]!.subscriberId;
  await Promise.all([a.confirm([id]), a.confirm([id])]);
  expect(
    await db.brand(
      a.w,
      a.brand,
      async (sql) =>
        (
          await sql.query(
            "SELECT count(*)::int n FROM subscriber_consent_events WHERE event='confirmed'",
          )
        ).rows[0]?.n,
    ),
  ).toBe(1);
  expect(
    customerAudienceCommands[
      "audienceOnboarding.confirmContacts"
    ].schema.safeParse({
      brandId: a.brand,
      operationKey: randomUUID(),
      subscriberIds: Array.from({ length: 251 }, () => randomUUID()),
      permissionAffirmed: true,
      source: "In-store signup",
      policyVersion: "v1",
    }).success,
  ).toBe(false);
});
