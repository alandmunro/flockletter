import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PlatformAlert } from "../../shared/platform.js";
import type { OperatorSession } from "../platform/auth.js";
import type { PlatformService } from "../platform/service.js";
import type { PlatformStore } from "../platform/store.js";
import { AppError, requireCondition } from "../errors.js";

const eventScope = "system:workspace-gifts:provider-events";
const eventActor = "workspace-gifts:vendor-event";
const observedActor = "workspace-gifts:funding-observed";
const currentKey = "gift-funding:current";
const sandbox = "https://testflight.tremendous.com/api/v2";
const production = "https://api.tremendous.com/api/v2";
const providerId = z.string().regex(/^[A-Z0-9]{4,20}$/);
const cents = z.number().int().nonnegative();
const states = z.enum([
  "created",
  "partially_credited",
  "fully_credited",
  "rejected",
  "reversed",
]);
const receipt = z.object({
  id: providerId,
  amount: z.number(),
  currency_code: z.literal("USD"),
  funding_source_id: providerId,
  idempotency_key: z.string(),
  status: states,
});
const balanceSource = z.object({
  id: providerId,
  method: z.literal("balance"),
  status: z.literal("active"),
  usage_permissions: z
    .array(z.string())
    .refine((values) => values.includes("api_orders")),
  meta: z.object({
    currency_code: z.literal("USD"),
    available_cents: z.number().int(),
    pending_cents: cents,
  }),
});
const bankSource = z.object({
  id: providerId,
  method: z.literal("bank_account"),
  status: z.literal("active"),
  usage_permissions: z
    .array(z.string())
    .refine((values) => values.includes("balance_funding")),
});
type Records = Parameters<Parameters<PlatformStore["transaction"]>[1]>[0];
type Platform = Pick<
  PlatformService,
  "store" | "db" | "options" | "notifications"
>;
type Coverage = {
  currency: "USD";
  available: number;
  pending: number;
  liability: number;
  buffer: number;
  shortfall: number;
};
type Intent = {
  key: string;
  amount: number;
  balanceId: string;
  source: string;
  operator: string;
  approvedAt: string;
  state: "unknown" | z.infer<typeof states>;
  providerId?: string;
};
const complete = (state: Intent["state"]) =>
  ["fully_credited", "rejected", "reversed"].includes(state);
const operation = (key: string) => "gift-funding:" + key;
const publicIntent = (intent: Intent) => ({
  operationKey: intent.key,
  amount: intent.amount,
  state: intent.state,
});
function verified(ok: unknown): asserts ok {
  if (!ok)
    throw new AppError(
      503,
      "gift_funding_unverified",
      "Gift funding requires reconciliation.",
    );
}
async function alert(
  records: Records,
  scope: string,
  code: string,
  active: boolean,
) {
  const old = await records.get<PlatformAlert>("alert", code);
  if (active === (old?.active ?? false)) return;
  const at = new Date().toISOString();
  await records.put("alert", code, {
    id: old?.id ?? randomUUID(),
    workspaceId: scope,
    code,
    active,
    acknowledgedAt: null,
    createdAt: old?.createdAt ?? at,
    updatedAt: at,
  } satisfies PlatformAlert);
  if (active) {
    const id = randomUUID();
    await records.put(
      "notification",
      id,
      {
        id,
        workspaceId: scope,
        code,
        state: "queued",
        providerId: null,
        createdAt: at,
      },
      true,
    );
  }
}

export class GiftFunding {
  private readonly scope: string;
  private constructor(
    private readonly platform: Platform,
    private readonly live: boolean,
    private readonly apiKey: string,
    private readonly expectedBalance: string,
    private readonly source: string | null,
    private readonly buffer: number,
    private readonly request: typeof fetch,
  ) {
    this.scope = live
      ? "_platform_gift_funding_live"
      : "_platform_gift_funding_sandbox";
  }

  static configured(
    platform: Platform,
    env: NodeJS.ProcessEnv = process.env,
    request: typeof fetch = fetch,
  ) {
    const environment = platform.options.environment;
    if (platform.options.mode !== "live" || env.APP_ENV !== environment)
      return null;
    const live = environment === "production";
    if (
      live &&
      (env.FLOCKLETTER_GIFT_FUNDING_MODE !== "live_readonly" ||
        env.FLOCKLETTER_WORKSPACE_GIFTS !== "live")
    )
      return null;
    if (!live && environment !== "staging") return null;
    const apiKey = env.FLOCKLETTER_GIFT_FUNDING_TREMENDOUS_KEY;
    if (!apiKey) return null;
    verified(
      (live ? /^PROD_[A-Za-z0-9_-]+$/ : /^TEST_[A-Za-z0-9_-]+$/).test(apiKey),
    );
    const rawBuffer = env.FLOCKLETTER_GIFT_FUNDING_BUFFER_CENTS;
    verified(rawBuffer !== undefined && /^(0|[1-9][0-9]*)$/.test(rawBuffer));
    const buffer = cents.parse(Number(rawBuffer));
    const source =
      !live && env.FLOCKLETTER_GIFT_SANDBOX_TOPUP === "approved"
        ? providerId.parse(env.FLOCKLETTER_GIFT_SANDBOX_FUNDING_SOURCE)
        : null;
    const expectedBalance = providerId.parse(env.FLOCKLETTER_GIFT_FUNDING_BALANCE_ID);
    return new GiftFunding(platform, live, apiKey, expectedBalance, source, buffer, request);
  }

  private async api(path: string, body?: object) {
    verified(
      !this.live || (path === "/funding_sources/BALANCE" && body === undefined),
    );
    const response = await this.request(
      (this.live ? production : sandbox) + path,
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (body && response.status === 409) return null;
    verified(response.ok);
    return (await response.json()) as unknown;
  }

  private async coverage(records: Records) {
    const { funding_source: balance } = z
      .object({ funding_source: balanceSource })
      .parse(await this.api("/funding_sources/BALANCE"));
    verified(balance.id === this.expectedBalance);
    const liability = cents.parse(await records.giftLiability());
    const target = cents.parse(liability + this.buffer);
    const value: Coverage = {
      currency: "USD",
      available: balance.meta.available_cents,
      pending: balance.meta.pending_cents,
      liability,
      buffer: this.buffer,
      shortfall: cents.parse(
        Math.max(0, target - balance.meta.available_cents),
      ),
    };
    return { id: balance.id, value };
  }

  private async lookup(intent: Intent) {
    if (intent.providerId) {
      const { topup } = z
        .object({ topup: receipt })
        .parse(await this.api("/topups/" + intent.providerId));
      verified(topup.id === intent.providerId);
      return topup;
    }
    // A lost create response has no provider ID. Only a complete search permits a same-key submission.
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const { topups } = z
        .object({
          topups: z.array(
            z.object({ idempotency_key: z.string().nullish() }).passthrough(),
          ),
        })
        .parse(await this.api("/topups?offset=" + offset));
      if (!topups.length) return null;
      const found = topups.filter(
        (item) => item.idempotency_key === operation(intent.key),
      );
      verified(found.length <= 1);
      if (found[0]) return receipt.parse(found[0]);
      offset += topups.length;
    }
    throw new Error("Sandbox funding lookup incomplete.");
  }

  private async operator(actor: OperatorSession) {
    requireCondition(
      !actor.exercise &&
        actor.authentication === "required" &&
        (await this.platform.options.identity.current(actor)),
      403,
      "operator_required",
      "Verify the current platform operator session.",
    );
  }

  private async sourceEligible(source: string) {
    const { funding_source } = z
      .object({ funding_source: bankSource })
      .parse(await this.api("/funding_sources/" + source));
    verified(funding_source.id === source);
  }

  async status() {
    try {
      return await this.platform.store.transaction(
        this.scope,
        async (records) => (await this.coverage(records)).value,
      );
    } catch {
      throw new AppError(
        503,
        "gift_funding_unverified",
        "Funding coverage could not be verified.",
      );
    }
  }

  /** Inspect coverage and reconcile the current (or an earlier) receipt. Never submits a top-up. */
  monitor(operationKey?: string) {
    if (operationKey !== undefined) z.uuid().parse(operationKey);
    return this.sync(operationKey);
  }

  /** Consume signed inbox notifications as lookup hints. Commit the private result before acknowledging the inbox. */
  async processEvents() {
    const events = await this.platform.db.read(
      eventScope,
      async (sql) =>
        (
          await sql.query<{
            operation_key: string;
            result: { kind: string; resource: string };
          }>(
            `SELECT e.operation_key, e.result FROM operations e
         WHERE e.workspace_id=$1 AND e.actor_id=$2
           AND split_part(e.result->>'kind','.',1) IN ('TOPUPS','FUNDING_SOURCES')
           AND NOT EXISTS (SELECT 1 FROM operations done WHERE done.workspace_id=e.workspace_id
             AND done.actor_id=$3 AND done.operation_key=e.operation_key)
         ORDER BY e.created_at,e.operation_key LIMIT 25`,
            [eventScope, eventActor, observedActor],
          )
        ).rows,
    );
    let processed = 0;
    for (const { operation_key: eventKey, result } of events) {
      try {
        if (!this.live && result.kind.startsWith("TOPUPS.")) {
          const id = providerId.parse(result.resource);
          const { topup } = z
            .object({
              topup: z.object({
                id: providerId,
                idempotency_key: z.string().nullish(),
              }),
            })
            .parse(await this.api("/topups/" + id));
          verified(topup.id === id);
          if (topup.idempotency_key?.startsWith("gift-funding:")) {
            const key = z
              .uuid()
              .parse(topup.idempotency_key.slice("gift-funding:".length));
            const observation = await this.sync(key, undefined, id);
            verified(observation.verified);
          }
        } else {
          verified((await this.monitor()).verified);
        }
      } catch {
        await this.platform.store.transaction(this.scope, (records) =>
          alert(records, this.scope, "gift_funding_event_unverified", true),
        );
        await this.platform.notifications(this.scope);
        continue;
      }
      await this.platform.db.tenant(eventScope, (sql) =>
        sql.query(
          `INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result)
         VALUES($1,$2,$3,$3,'{}') ON CONFLICT DO NOTHING`,
          [eventScope, observedActor, eventKey],
        ),
      );
      processed++;
    }
    if (events.length < 25 && events.length === processed)
      await this.platform.store.transaction(this.scope, (records) =>
        alert(records, this.scope, "gift_funding_event_unverified", false),
      );
    return { processed, unresolved: events.length - processed };
  }

  /** Input is limited to the reviewed amount and operation key. Account, source and liability come from the server. */
  async approve(
    actor: OperatorSession,
    operationKey: string,
    expectedShortfall: number,
  ) {
    requireCondition(
      !this.live,
      403,
      "gift_topup_disabled",
      "Production funding is read-only.",
    );
    await this.operator(actor);
    const key = z.uuid().parse(operationKey);
    const amount = cents.positive().parse(expectedShortfall);
    requireCondition(
      this.source,
      403,
      "gift_topup_disabled",
      "A private sandbox funding source must be approved.",
    );
    const source = this.source;
    // Commit the original approval before any external write, including after a lost response or restart.
    await this.platform.store.transaction(this.scope, async (records) => {
      const prior = await records.get<Intent>("ack", operation(key));
      if (prior) {
        requireCondition(
          prior.amount === amount && prior.source === source,
          409,
          "gift_topup_conflict",
          "Retry the original approval.",
        );
        return;
      }
      const current = await records.get<string>("ack", currentKey);
      if (current) {
        const previous = await records.get<Intent>("ack", operation(current));
        requireCondition(
          previous && complete(previous.state),
          409,
          "gift_topup_pending",
          "Reconcile the existing top-up first.",
        );
      }
      const { id, value } = await this.coverage(records);
      requireCondition(
        value.shortfall === amount,
        409,
        "gift_shortfall_changed",
        "Review the current shortfall.",
      );
      await this.sourceEligible(source);
      await this.operator(actor);
      const intent: Intent = {
        key,
        source,
        balanceId: id,
        amount,
        operator: actor.userId,
        approvedAt: new Date().toISOString(),
        state: "unknown",
      };
      await records.put("ack", operation(key) + ":approved", intent, true);
      await records.put("ack", operation(key), intent, true);
      await records.put("ack", currentKey, key);
    });
    return this.sync(key, actor);
  }

  private async sync(
    key?: string,
    actor?: OperatorSession,
    eventResource?: string,
  ) {
    verified(!this.live || (!key && !actor && !eventResource));
    const result = await this.platform.store.transaction(
      this.scope,
      async (records) => {
        let coverage: Coverage | null = null;
        const selected = this.live
          ? null
          : (key ?? (await records.get<string>("ack", currentKey)));
        const intent = selected
          ? await records.get<Intent>("ack", operation(selected))
          : null;
        requireCondition(
          !selected || intent,
          404,
          "gift_topup_missing",
          "No matching funding intent.",
        );
        let observed: z.infer<typeof receipt> | null = null;
        let uncertain = false;
        try {
          const snapshot = await this.coverage(records);
          coverage = snapshot.value;
          if (intent) {
            verified(snapshot.id === intent.balanceId);
            verified(
              !eventResource ||
                !intent.providerId ||
                intent.providerId === eventResource,
            );
            observed = await this.lookup(
              eventResource ? { ...intent, providerId: eventResource } : intent,
            );
            if (
              !observed &&
              actor &&
              !intent.providerId &&
              !complete(intent.state)
            ) {
              verified(
                intent.source === this.source &&
                  intent.amount === coverage.shortfall &&
                  Math.round((intent.amount / 100) * 100) === intent.amount,
              );
              await this.sourceEligible(intent.source);
              await this.operator(actor);
              const data = await this.api("/topups", {
                funding_source_id: intent.source,
                idempotency_key: operation(intent.key),
                amount: intent.amount / 100,
              });
              observed =
                data === null
                  ? await this.lookup(intent)
                  : z.object({ topup: receipt }).parse(data).topup;
            }
            verified(
              observed &&
                observed.funding_source_id === intent.source &&
                observed.currency_code === "USD" &&
                observed.amount === intent.amount / 100 &&
                observed.idempotency_key === operation(intent.key),
            );
            verified(
              !complete(intent.state) ||
                observed.status === intent.state ||
                (intent.state === "fully_credited" &&
                  observed.status === "reversed"),
            );
          }
        } catch (error) {
          if (error instanceof AppError && error.code === "operator_required")
            throw error;
          observed = null;
          uncertain = true;
        }
        if (observed && intent) {
          intent.state = observed.status;
          intent.providerId = observed.id;
          await records.put(
            "ack",
            operation(intent.key) + ":" + intent.state,
            { ...intent, observedAt: new Date().toISOString() },
            true,
          );
          await records.put("ack", operation(intent.key), intent);
          if (intent.state === "rejected" || intent.state === "reversed")
            await alert(
              records,
              this.scope,
              "gift_topup_" + intent.state,
              true,
            );
        }
        if (coverage)
          await alert(
            records,
            this.scope,
            "gift_funding_shortfall",
            coverage.shortfall > 0,
          );
        await alert(records, this.scope, "gift_funding_unverified", uncertain);
        return {
          coverage,
          verified: !uncertain,
          topup: intent ? publicIntent(intent) : null,
        };
      },
    );
    // Durable, edge-triggered operator outbox. Staging uses the platform's existing capture/transport policy.
    await this.platform.notifications(this.scope);
    return result;
  }
}
