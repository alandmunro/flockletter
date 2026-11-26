import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startDatabase } from "../scripts/database-fixture.js";
import { Database } from "../src/server/db.js";
import { OperatorStore } from "../src/server/platform/store.js";
import { operatorRoleGrants } from "../src/server/platform/provision.js";
import type { OperatorSession } from "../src/server/platform/auth.js";
import { PlatformService } from "../src/server/platform/service.js";
import { CustomerSupport } from "../src/server/customer-support/index.js";
import { put, type Lot } from "../src/server/workspace-gifts/store.js";
import { GiftFunding } from "../src/server/workspace-gifts/funding.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const scope = "_platform_gift_funding_sandbox";
const inbox = "system:workspace-gifts:provider-events";
const bankId = "BANK0001",
  balanceId = "BALANCE0001";
const actor: OperatorSession = {
  userId: "operator",
  sessionId: "verified",
  exercise: false,
  authentication: "required",
  verifiedAt: new Date().toISOString(),
};
const env = {
  APP_ENV: "staging",
  FLOCKLETTER_GIFT_FUNDING_TREMENDOUS_KEY: "TEST_fixture",
  FLOCKLETTER_GIFT_SANDBOX_FUNDING_SOURCE: bankId,
  FLOCKLETTER_GIFT_FUNDING_BALANCE_ID: balanceId,
  FLOCKLETTER_GIFT_SANDBOX_TOPUP: "approved",
  FLOCKLETTER_GIFT_FUNDING_BUFFER_CENTS: "100",
};
type Topup = {
  id: string;
  amount: number;
  currency_code: string;
  idempotency_key: string;
  funding_source_id: string;
  status: string;
};
class Vendor {
  available = 200;
  pending = 1500;
  currency = "USD";
  source = {
    id: bankId,
    method: "bank_account",
    status: "active",
    usage_permissions: ["balance_funding"],
  };
  attempts = 0;
  lostResponse = false;
  conflict = false;
  offline = false;
  catalogueOffline = false;
  submitOffline = false;
  topups: Topup[] = [];
  paths: string[] = [];

  fetch: typeof fetch = async (input, options) => {
    const url = new URL(String(input)),
      method = options?.method;
    expect(url.origin).toBe("https://testflight.tremendous.com");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      "Bearer TEST_fixture",
    );
    const path = url.pathname.replace("/api/v2", "");
    this.paths.push(method + " " + path);
    if (path === "/funding_sources/BALANCE") {
      if (this.offline) return jsonResponse({}, 503);
      return jsonResponse({
        funding_source: {
          id: balanceId,
          method: "balance",
          status: "active",
          usage_permissions: ["api_orders"],
          meta: {
            currency_code: this.currency,
            available_cents: this.available,
            pending_cents: this.pending,
          },
        },
      });
    }
    if (path === "/funding_sources/" + bankId)
      return jsonResponse({ funding_source: this.source });
    if (path === "/topups" && method === "POST") {
      this.attempts++;
      if (this.submitOffline)
        throw new Error("Simulated interruption before acceptance.");
      const body = JSON.parse(String(options?.body));
      expect(body.funding_source_id).toBe(bankId);
      if (
        this.topups.some(
          (item) => item.idempotency_key === body.idempotency_key,
        )
      )
        return jsonResponse({}, 409);
      const topup = {
        ...body,
        id: "TOPUP000" + (this.topups.length + 1),
        status: "created",
        currency_code: "USD",
      };
      this.topups.push(topup);
      if (this.lostResponse)
        throw new Error("Simulated interruption after acceptance.");
      return this.conflict ? jsonResponse({}, 409) : jsonResponse({ topup });
    }
    if (path === "/topups")
      return this.catalogueOffline
        ? jsonResponse({}, 503)
        : jsonResponse({
            topups: this.topups.slice(
              Number(url.searchParams.get("offset")),
              Number(url.searchParams.get("offset")) + 1,
            ),
          });
    const found = this.topups.find((t) => path === "/topups/" + t.id);
    if (found) return jsonResponse({ topup: found });
    throw new Error("Unexpected test request.");
  };
}

describe("sandbox gift funding", () => {
  let fixture: Awaited<ReturnType<typeof startDatabase>>,
    db: Database,
    admin: pg.Client,
    platform: PlatformService;
  let vendor: Vendor, service: GiftFunding, authorized: boolean;
  const orgs = [
    "org_fundingA",
    "org_fundingB",
    "org_fundingA",
    "fixture:gifting:audience:v1:studio",
    inbox,
  ];
  const configured = (override: NodeJS.ProcessEnv = {}) =>
    GiftFunding.configured(platform, { ...env, ...override }, vendor.fetch);
  async function lot(workspace: string, reserved: number) {
    const l: Lot = {
      id: "gift-lot",
      brand: "brand",
      account: "test",
      face: 3000,
      fee: 300,
      total: 3300,
      created: new Date().toISOString(),
      state: "funded",
      reserved,
      spent: 0,
      returned: 0,
      disputed: 0,
      lost: 0,
      disputes: {},
    };
    await db.tenant(workspace, (sql) => put(sql, workspace, "lot", l.id, l));
  }
  async function event(key: string, kind: string, resource: string) {
    await db.tenant(inbox, (sql) =>
      sql.query(
        "INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING",
        [
          inbox,
          "workspace-gifts:vendor-event",
          key,
          JSON.stringify({ kind, resource }),
        ],
      ),
    );
  }

  beforeAll(async () => {
    fixture = await startDatabase();
    db = new Database(fixture.url);
    admin = new pg.Client({ connectionString: fixture.adminUrl });
    await admin.connect();
    const role = "flockletter_gift_test_operator",
      password = randomUUID();
    await admin.query(
      "CREATE ROLE " + role + " LOGIN PASSWORD " + pg.escapeLiteral(password),
    );
    await admin.query(operatorRoleGrants("flockletter_test", role));
    const url = new URL(fixture.adminUrl);
    url.username = role;
    url.password = password;
    const store = new OperatorStore(db, "live", url.href);
    await store.verify();
    platform = new PlatformService(db, store, {
      environment: "staging",
      mode: "live",
      databaseName: "flockletter_test",
      identity: {
        authenticate: async () => actor,
        current: async () => authorized,
      },
      support: new CustomerSupport(db, { mode: "capture" }),
    });
  });
  afterAll(async () => {
    await platform?.close();
    await admin?.end();
    await db?.close();
    await fixture?.stop();
  });
  beforeEach(async () => {
    await admin.query(
      "DELETE FROM flockletter_retention_control.platform_records WHERE workspace_id=$1",
      [scope],
    );
    await lot(orgs[0]!, 800);
    await lot(orgs[0]!, 600);
    await lot(orgs[1]!, 500);
    await lot(orgs[3]!, 99999);
    authorized = true;
    vendor = new Vendor();
    service = configured()!;
    platform.giftFunding = service;
  });

  it("binds a probation decision and a dispute release to a current operator case and the affected brand", async () => {
    const workspace='org_'+randomUUID(), brand=randomUUID(), other=randomUUID(), incident='dp_reviewed';
    const reason='Reviewed the verified workspace and original dispute.';
    await db.tenant(workspace,async sql=>{
      await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)',[workspace,'Review test']);
      for(const id of [brand,other])await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)',[workspace,id,id===brand?'Review subject':'Other brand']);
      await put(sql,workspace,'lot','paid',{id:'paid',brand,account:'test',face:1000,fee:100,total:1100,
        state:'funded',created:new Date().toISOString(),reserved:0,spent:0,returned:0,disputed:0,lost:100,
        disputes:{[incident]:{amount:100,state:'lost',opened:new Date().toISOString()}}});
      await put(sql,workspace,'signal','probation_loss',{kind:'review_required',ref:incident,at:new Date().toISOString()});
    });
    const open=async(resourceId:string)=>(await platform.execute('platform.openCase',{workspaceId:workspace,
      operationKey:randomUUID(),kind:'abuse',resourceId,reason},actor) as {id:string}).id;
    const caseId=await open(brand),wrong=await open(other);
    const decide={caseId,operationKey:randomUUID(),decision:'complete',reason,expectedRevision:null};
    await platform.execute('platform.reviewGiftEligibility',decide,actor);
    await platform.execute('platform.reviewGiftEligibility',decide,actor);
    await expect(platform.execute('platform.reviewGiftEligibility',{...decide,operationKey:randomUUID()},actor))
      .rejects.toMatchObject({code:'gift_review_changed'});
    await expect(platform.execute('platform.giftReview',{caseId},actor)).resolves.toMatchObject({decision:'complete',incident});
    const release={caseId,operationKey:randomUUID(),expectedIncident:incident,reason};
    await expect(platform.execute('platform.releaseGiftHold',{...release,caseId:wrong},actor)).rejects.toMatchObject({code:'gift_review_changed'});
    await platform.execute('platform.releaseGiftHold',release,actor);
    await expect(platform.execute('platform.giftReview',{caseId},actor)).resolves.toMatchObject({incident:null});
  });
  it("counts latest reservations across real workspaces, excludes fixtures and pending funding, and alerts once per shortfall", async () => {
    expect((await service.monitor()).coverage).toEqual({
      currency: "USD",
      available: 200,
      pending: 1500,
      buffer: 100,
      liability: 1100,
      shortfall: 1000,
    });
    await service.monitor();
    let notices = await platform.store.read<{ code: string; state: string }>(
      "notification",
      scope,
    );
    expect(notices.map((n) => [n.code, n.state])).toEqual([
      ["gift_funding_shortfall", "captured"],
    ]);
    vendor.available = 1200;
    await service.monitor();
    vendor.available = 200;
    await service.monitor();
    notices = await platform.store.read("notification", scope);
    expect(notices).toHaveLength(2);
    expect(vendor.attempts).toBe(0);
  });

  it("fails closed outside staging, on unauthorized sessions, incorrect private sources or unverified balances", async () => {
    expect(configured({ APP_ENV: "production" })).toBeNull();
    expect(
      configured({
        FLOCKLETTER_GIFT_FUNDING_TREMENDOUS_KEY: undefined,
        TREMENDOUS_SANDBOX_API_KEY: "TEST_fixture",
      }),
    ).toBeNull();
    expect(() =>
      configured({ FLOCKLETTER_GIFT_FUNDING_TREMENDOUS_KEY: "PROD_fixture" }),
    ).toThrow();
    const key = randomUUID(),
      readOnly = configured({ FLOCKLETTER_GIFT_SANDBOX_TOPUP: undefined })!;
    await expect(readOnly.approve(actor, key, 1000)).rejects.toMatchObject({
      code: "gift_topup_disabled",
    });
    await expect(
      service.approve({ ...actor, exercise: true }, key, 1000),
    ).rejects.toMatchObject({ code: "operator_required" });
    authorized = false;
    await expect(service.approve(actor, key, 1000)).rejects.toMatchObject({
      code: "operator_required",
    });
    authorized = true;
    await expect(service.approve(actor, key, 999)).rejects.toMatchObject({
      code: "gift_shortfall_changed",
    });
    for (const change of [
      { status: "pending_confirmation" },
      { method: "credit_card" },
      { id: "OTHERBANK" },
      { usage_permissions: [] },
    ]) {
      const original = vendor.source;
      vendor.source = { ...original, ...change };
      await expect(service.approve(actor, key, 1000)).rejects.toThrow();
      vendor.source = original;
    }
    vendor.currency = "EUR";
    expect(await service.monitor()).toMatchObject({
      coverage: null,
      verified: false,
    });
    expect(vendor.attempts).toBe(0);
  });

  it("commits one approval across concurrent operations, restarts, partial credit and a later reversal", async () => {
    const key = randomUUID(),
      rival = randomUUID();
    vendor.lostResponse = true;
    const replies = await Promise.allSettled([
      service.approve(actor, key, 1000),
      service.approve(actor, rival, 1000),
    ]);
    expect(replies.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const original = vendor.topups[0]!;
    const accepted = original.idempotency_key.split(":")[1]!;
    expect(vendor.attempts).toBe(1);
    expect(original.amount).toBe(10);
    service = configured()!;
    await expect(service.approve(actor, accepted, 999)).rejects.toMatchObject({
      code: "gift_topup_conflict",
    });
    expect((await service.approve(actor, accepted, 1000)).topup?.state).toBe(
      "created",
    );
    vendor.available = 700;
    original.status = "partially_credited";
    expect(await service.monitor()).toMatchObject({
      topup: { state: "partially_credited" },
      coverage: { shortfall: 500 },
    });
    await expect(
      service.approve(actor, randomUUID(), 500),
    ).rejects.toMatchObject({ code: "gift_topup_pending" });
    vendor.available = 1200;
    original.status = "fully_credited";
    expect((await service.monitor()).topup?.state).toBe("fully_credited");
    vendor.available = 200;
    vendor.lostResponse = false;
    vendor.conflict = true;
    const next = randomUUID();
    expect((await service.approve(actor, next, 1000)).topup?.state).toBe(
      "created",
    );
    original.status = "reversed";
    const eventId = randomUUID();
    await event(eventId, "TOPUPS.REVERSED", original.id);
    await event(eventId, "TOPUPS.REVERSED", original.id);
    expect(await service.processEvents()).toEqual({
      processed: 1,
      unresolved: 0,
    });
    expect(await service.processEvents()).toEqual({
      processed: 0,
      unresolved: 0,
    });
    expect((await service.monitor(accepted)).topup?.state).toBe("reversed");
    expect((await service.monitor()).topup?.operationKey).toBe(next);
    const alerts = await platform.store.read<{ code: string; active: boolean }>(
      "alert",
      scope,
    );
    expect(alerts.find((a) => a.code === "gift_topup_reversed")?.active).toBe(
      true,
    );
    expect(vendor.attempts).toBe(2);
  });

  it("requires complete lookup, matches economic identity, and leaves failed events in the append-only inbox", async () => {
    const key = randomUUID();
    vendor.submitOffline = true;
    expect((await service.approve(actor, key, 1000)).verified).toBe(false);
    vendor.submitOffline = false;
    vendor.catalogueOffline = true;
    expect((await service.approve(actor, key, 1000)).verified).toBe(false);
    expect(vendor.attempts).toBe(1);
    vendor.catalogueOffline = false;
    await service.approve(actor, key, 1000);
    const t = vendor.topups[0]!;
    t.amount = 1234;
    await event(randomUUID(), "TOPUPS.REJECTED", t.id);
    expect(await service.processEvents()).toEqual({
      processed: 0,
      unresolved: 1,
    });
    t.amount = 10;
    t.status = "rejected";
    expect(await service.processEvents()).toEqual({
      processed: 1,
      unresolved: 0,
    });
    expect((await service.monitor()).topup?.state).toBe("rejected");
    expect(vendor.attempts).toBe(2);
  });
  it("registers operator commands, rejects workspace exercise access, and uses the worker for alerts", async () => {
    await expect(
      platform.execute("platform.giftFundingStatus", {}, actor),
    ).resolves.toMatchObject({ currency: "USD", shortfall: 1000 });
    await expect(
      platform.execute(
        "platform.giftFundingStatus",
        { workspaceIds: [] },
        actor,
      ),
    ).rejects.toThrow();
    await expect(
      platform.execute(
        "platform.giftFundingStatus",
        {},
        { ...actor, exercise: true },
      ),
    ).rejects.toThrow();
    const key = randomUUID();
    await expect(
      platform.execute(
        "platform.approveGiftTopup",
        { operationKey: key, expectedShortfallCents: 1000 },
        actor,
      ),
    ).resolves.toMatchObject({
      verified: true,
      topup: { operationKey: key, state: "created" },
    });
    await event(randomUUID(), "FUNDING_SOURCES.FUNDED", balanceId);
    await platform.monitor();
    expect(await service.processEvents()).toEqual({
      processed: 0,
      unresolved: 0,
    });
    expect(vendor.attempts).toBe(1);
  });

  it("refuses incomplete or quarantined inventory and denies runtime reads of private liability", async () => {
    await expect(
      db.pool.query(
        "SELECT * FROM flockletter_retention_control.gift_funding_lots",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.pool.query(
        "SELECT flockletter_retention_control.gift_funding_liability()",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await admin.query(
      "ALTER TABLE operations DISABLE TRIGGER gift_funding_insert",
    );
    try {
      await expect(service.status()).rejects.toMatchObject({
        code: "gift_funding_unverified",
      });
      expect((await service.monitor()).verified).toBe(false);
      await expect(
        service.approve(actor, randomUUID(), 1000),
      ).rejects.toThrow();
      expect(vendor.attempts).toBe(0);
    } finally {
      await admin.query(
        "ALTER TABLE operations ENABLE ALWAYS TRIGGER gift_funding_insert",
      );
    }
    await admin.query(
      "DELETE FROM flockletter_retention_control.gift_funding_lots WHERE workspace_id=''",
    );
    try {
      await expect(service.status()).rejects.toThrow();
    } finally {
      await admin.query(
        "INSERT INTO flockletter_retention_control.gift_funding_lots SELECT '','baseline','v1',0,count(*) FROM flockletter_retention_control.gift_funding_lots",
      );
    }
  });

  it('rebuilds an incomplete inventory from historical append-only revisions and honors restore quarantine', async()=>{
    await admin.query("DELETE FROM flockletter_retention_control.gift_funding_lots WHERE workspace_id=$1",[orgs[0]]);
    await expect(service.status()).rejects.toMatchObject({code:'gift_funding_unverified'});
    const migration = await readFile(new URL('../migrations/050_gift_funding_inventory.sql',import.meta.url),'utf8');
    await admin.query(migration);
    expect(await service.status()).toMatchObject({liability:1100});
    await admin.query("INSERT INTO flockletter_retention_control.restore_quarantines(workspace_id,checkpoint_digest,checkpoint_version,protected_phase,blocked) VALUES($1,'fixture','v1','quarantined',true)",[orgs[0]]);
    try {
      await expect(service.status()).rejects.toMatchObject({code:'gift_funding_unverified'});
      await expect(service.approve(actor,randomUUID(),1000)).rejects.toThrow();
      expect(vendor.attempts).toBe(0);
    } finally {await admin.query('DELETE FROM flockletter_retention_control.restore_quarantines WHERE workspace_id=$1',[orgs[0]]);}
  });

  it('refuses an automatic draw above the cap and settles one draw at the exact cap', async () => {
    const automatic = configured({
      FLOCKLETTER_GIFT_FUNDING_MODE: "sandbox_automatic",
      FLOCKLETTER_GIFT_TOPUP_LIMIT_CENTS: "1000",
    })!;
    vendor.pending = 0;
    vendor.available = 199;
    expect((await automatic.replenish()).coverage).toMatchObject({ shortfall: 1001 });
    expect(vendor.attempts).toBe(0);

    vendor.available = 200;
    await automatic.replenish();
    expect(vendor.topups).toHaveLength(1);
    const transfer = vendor.topups[0]!;
    expect(transfer.amount).toBe(10);
    transfer.status = "fully_credited";
    vendor.available = 1200;
    expect(await automatic.replenish()).toMatchObject({
      coverage: { shortfall: 0 },
      topup: { state: "fully_credited" },
    });
    await automatic.replenish();
    expect(vendor.attempts).toBe(1);
  });

  it('keeps a single automatic draw through concurrent ticks, uncertain settlement and reversal',async()=>{
    const automatic=GiftFunding.configured(platform,{...env,FLOCKLETTER_GIFT_FUNDING_MODE:'sandbox_automatic',
      FLOCKLETTER_GIFT_TOPUP_LIMIT_CENTS:'1500'},vendor.fetch)!;
    vendor.pending=0;
    vendor.lostResponse=true;
    await Promise.all([automatic.replenish(),automatic.replenish()]);
    expect(vendor.attempts).toBe(1);
    vendor.topups[0]!.status='partially_credited';
    expect((await automatic.replenish()).topup?.state).toBe('partially_credited');
    vendor.topups[0]!.status='reversed';
    expect((await automatic.replenish()).topup?.state).toBe('reversed');
    await automatic.replenish();
    expect(vendor.attempts).toBe(1);
  });
  it("uses only production balance GET in approved live read-only mode even with sandbox approval settings", async () => {
    const livePlatform = new PlatformService(db, platform.store, {
      ...platform.options,
      environment: "production",
    });
    const liveEnv = {
      ...env,
      APP_ENV: "production",
      FLOCKLETTER_GIFT_FUNDING_MODE: "live_readonly",
      FLOCKLETTER_WORKSPACE_GIFTS: "live",
      FLOCKLETTER_GIFT_FUNDING_TREMENDOUS_KEY: "PROD_fixture",
    };
    const urls: string[] = [];
    const request: typeof fetch = async (input, options) => {
      urls.push(String(input));
      expect(options?.method).toBe("GET");
      return jsonResponse({
        funding_source: {
          id: balanceId,
          method: "balance",
          status: "active",
          usage_permissions: ["api_orders"],
          meta: {
            currency_code: "USD",
            available_cents: 250,
            pending_cents: 0,
          },
        },
      });
    };
    expect(
      GiftFunding.configured(
        livePlatform,
        { ...liveEnv, FLOCKLETTER_GIFT_FUNDING_MODE: undefined },
        request,
      ),
    ).toBeNull();
    const live = GiftFunding.configured(livePlatform, liveEnv, request)!;
    livePlatform.giftFunding = live;
    expect(
      await livePlatform.execute("platform.giftFundingStatus", {}, actor),
    ).toMatchObject({ shortfall: 950 });
    await expect(
      livePlatform.execute(
        "platform.approveGiftTopup",
        { operationKey: randomUUID(), expectedShortfallCents: 950 },
        actor,
      ),
    ).rejects.toMatchObject({ code: "gift_topup_disabled" });
    expect(urls).toEqual([
      "https://api.tremendous.com/api/v2/funding_sources/BALANCE",
    ]);
  });
});
