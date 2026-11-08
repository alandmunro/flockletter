import { X509Certificate, verify } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import type { CampaignFeedbackKind } from '../../shared/rehearsal.js';
import type { SesRoute } from './ses-runtime.js';
import { listmonkBinding } from './private-listmonk.js';
import { recordCampaignFeedback } from './feedback.js';

const failed = () =>
  new AppError(403, 'invalid_provider_event', 'The provider notification could not be authenticated.');
const invalid = () => new AppError(400, 'invalid_provider_event', 'Invalid provider notification.');
const unmapped = () =>
  new AppError(409, 'feedback_unmapped', 'The provider notification does not match this simulator binding.');
const notification = z.object({
  Type: z.enum(['Notification', 'SubscriptionConfirmation']),
  MessageId: z.uuid(),
  Message: z.string().min(1),
  TopicArn: z.string(),
  Timestamp: z.iso.datetime(),
  Subject: z.string().optional(),
  SignatureVersion: z.literal('2'),
  Signature: z.string().regex(/^[A-Za-z0-9+/]{100,1024}={0,2}$/),
  SigningCertURL: z.string(),
  SubscribeURL: z.string().optional(),
  Token: z.string().max(8192).optional(),
});
type Notification = z.infer<typeof notification>;
function readNotification(body: Buffer) {
  try { return notification.parse(JSON.parse(body.toString('utf8'))); }
  catch { throw invalid(); }
}
export class SesFeedbackRouter {
  private handlers: Map<string, SesNotifications>;
  constructor(handlers: readonly SesNotifications[]) {
    this.handlers = new Map(handlers.map(handler => [handler.route.topicArn, handler]));
  }
  async handle(db: Database, body: Buffer) {
    const msg = readNotification(body);
    const handler = this.handlers.get(msg.TopicArn);
    if (!handler) throw failed();
    await handler.verifyAndApply(db, msg);
  }
}
const trustedOrigin = (route: SesRoute) => 'https://sns.' + route.region + '.amazonaws.com';
function signedBytes(msg: Notification) {
  const keys: (keyof Notification)[] =
    msg.Type === 'Notification'
      ? [
          'Message',
          'MessageId',
          ...(msg.Subject !== undefined ? ['Subject' as const] : []),
          'Timestamp',
          'TopicArn',
          'Type',
        ]
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  if (keys.some((k) => msg[k] === undefined)) throw invalid();
  return Buffer.from(keys.map((k) => k + '\n' + msg[k] + '\n').join(''), 'utf8');
}
const defaultCert = async (url: string) => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4000) });
  if (!response.ok || !response.body) throw Error();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) throw Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new X509Certificate(Buffer.concat(chunks));
};
type CertificateLoader = (url: string) => Promise<X509Certificate>;
export class SesNotifications {
  private cached?: { url: string; cert: X509Certificate; until: number };
  private pending?: { url: string; load: Promise<X509Certificate> };
  constructor(
    readonly route: SesRoute,
    private load: CertificateLoader = defaultCert,
    private confirm: (url: string) => Promise<void> = async (url) => {
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4000) });
      await res.body?.cancel();
      if (!res.ok) throw Error();
    },
  ) {}
  private async cert(url: string) {
    const parsed = new URL(url);
    if (
      parsed.origin !== trustedOrigin(this.route) ||
      url !== parsed.origin + parsed.pathname ||
      !/^\/SimpleNotificationService-[a-fA-F0-9]{32,64}\.pem$/.test(parsed.pathname)
    )
      throw failed();
    if (this.cached?.url === url && this.cached.until > Date.now()) return this.cached.cert;
    if (this.pending && this.pending.url !== url)
      throw new AppError(503, 'certificate_busy', 'Retry the provider notification.');
    const loading = (this.pending ??= { url, load: this.load(url) });
    try {
      const cert = await loading.load;
      this.cached = { url, cert, until: Date.now() + 60 * 60 * 1000 };
      return cert;
    } catch {
      throw new AppError(503, 'certificate_unavailable', 'Retry the provider notification.');
    } finally {
      if (this.pending === loading) this.pending = undefined;
    }
  }
  async handle(db: Database, body: Buffer) {
    return this.verifyAndApply(db, readNotification(body));
  }
  async verifyAndApply(db: Database, msg: Notification) {
    if (msg.TopicArn !== this.route.topicArn || Date.parse(msg.Timestamp) > Date.now() + 5 * 60000)
      throw failed();
    let cert: X509Certificate;
    try {
      cert = await this.cert(msg.SigningCertURL);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw failed();
    }
    const timestamp = Date.parse(msg.Timestamp);
    if (
      timestamp < Date.parse(cert.validFrom) ||
      timestamp > Date.parse(cert.validTo) ||
      cert.publicKey.asymmetricKeyType !== 'rsa' ||
      !verify('RSA-SHA256', signedBytes(msg), cert.publicKey, Buffer.from(msg.Signature, 'base64'))
    )
      throw failed();
    if (msg.Type === 'SubscriptionConfirmation') {
      if (!msg.SubscribeURL || !msg.Token) throw invalid();
      let url: URL;
      try {
        url = new URL(msg.SubscribeURL);
      } catch {
        throw invalid();
      }
      if (
        url.origin !== trustedOrigin(this.route) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.hash ||
        [...url.searchParams].length !== 3 ||
        url.searchParams.get('Action') !== 'ConfirmSubscription' ||
        url.searchParams.get('TopicArn') !== this.route.topicArn ||
        url.searchParams.get('Token') !== msg.Token
      )
        throw failed();
      try {
        await this.confirm(url.href);
      } catch {
        throw new AppError(503, 'confirmation_unavailable', 'Retry SNS subscription confirmation.');
      }
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(msg.Message);
    } catch {
      throw invalid();
    }
    const event = decodeSesEvent(this.route, raw);
    if (!event) return;
    await db.brand(this.route.workspaceId, this.route.brandId, async (sql) => {
      const owner = (
        await sql.query<{ transport: string }>(
          `SELECT r.transport FROM campaign_rehearsals r
        JOIN rehearsal_recipients p ON (p.workspace_id,p.brand_id,p.rehearsal_id)=(r.workspace_id,r.brand_id,r.id)
        WHERE p.id=$1 AND r.transport IN ('ses_simulator','listmonk_ses')`,
          [event.operation],
        )
      ).rows[0];
      if (!owner) throw unmapped();
      const viaEngine = owner.transport === 'listmonk_ses';
      await recordCampaignFeedback(sql, {
        workspace: this.route.workspaceId,
        brand: this.route.brandId,
        binding: viaEngine
          ? listmonkBinding(
              this.route.workspaceId,
              this.route.brandId,
              'listmonk_ses',
              this.route.fingerprint,
            )
          : this.route.fingerprint,
        transport: viaEngine ? 'listmonk_ses' : 'ses_simulator',
        eventId: msg.MessageId,
        ...event,
      });
    });
  }
}
const emails = z.array(z.object({ emailAddress: z.email() })).length(1);
const eventSchema = z.object({
  eventType: z.string(),
  mail: z.object({
    messageId: z.string().min(1).max(256),
    sendingAccountId: z.string(),
    source: z.string(),
    sourceArn: z.string(),
    destination: z.array(z.email()).length(1),
    tags: z.record(z.string(), z.array(z.string())),
  }),
  delivery: z.object({ recipients: z.array(z.email()).length(1) }).optional(),
  bounce: z
    .object({ bounceType: z.enum(['Permanent', 'Transient', 'Undetermined']), bouncedRecipients: emails })
    .optional(),
  complaint: z.object({ complainedRecipients: emails }).optional(),
});
export function decodeSesEvent(route: SesRoute, input: unknown) {
  const type = z.object({ eventType: z.string() }).safeParse(input);
  if (!type.success) throw invalid();
  if (!['Delivery', 'Bounce', 'Complaint'].includes(type.data.eventType)) return;
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const e = parsed.data,
    m = e.mail,
    dest = m.destination[0]!;
  const tag = (key: string) => (m.tags[key]?.length === 1 ? m.tags[key]![0] : undefined);
  const operation = tag('fl_operation');
  if (
    m.sendingAccountId !== route.accountId ||
    m.sourceArn !== route.identityArn ||
    m.source !== route.from ||
    tag('fl_tenant') !== route.tenant ||
    tag('ses:configuration-set') !== route.configurationSet ||
    !operation ||
    !z.uuid().safeParse(operation).success ||
    !['success', 'bounce', 'complaint'].some((v) => dest === v + '@simulator.amazonses.com')
  )
    throw unmapped();
  let kind: CampaignFeedbackKind;
  if (e.eventType === 'Delivery' && e.delivery?.recipients[0] === dest) kind = 'delivered';
  else if (e.eventType === 'Bounce' && e.bounce?.bouncedRecipients[0]?.emailAddress === dest)
    kind = e.bounce.bounceType === 'Permanent' ? 'permanent_bounce' : 'temporary_bounce';
  else if (e.eventType === 'Complaint' && e.complaint?.complainedRecipients[0]?.emailAddress === dest)
    kind = 'complaint';
  else throw unmapped();
  return { kind, operation, destination: dest, messageId: m.messageId };
}
