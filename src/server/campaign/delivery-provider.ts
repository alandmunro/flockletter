import { createHash } from 'node:crypto';
import type { Sql } from '../db.js';
import { isPracticeAddress } from './rehearsal.js';

export type DeliveryEnvelope = {
  operationKey: string;
  workspaceId: string;
  brandId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  images: { name: string; mime: string; sha256: string; bytes: Buffer }[];
};
// not_submitted is authoritative proof that this attempt cannot have been accepted.
// An absent, late or untrusted external receipt is unknown.
export type DeliveryOutcome = 'accepted' | 'rejected' | 'unknown' | 'not_submitted';
export interface DeliveryProvider {
  submit(message: DeliveryEnvelope): Promise<DeliveryOutcome>;
  lookup(operationKey: string): Promise<DeliveryOutcome>;
}

// Hosted staging uses a local receipt store. It has no network transport or credentials.
export class StagingReceiptProvider implements DeliveryProvider {
  constructor(
    private sql: Sql,
    private workspace: string,
    private brand: string,
    private rehearsal: string,
  ) {}

  async submit(message: DeliveryEnvelope): Promise<DeliveryOutcome> {
    if (
      message.workspaceId !== this.workspace ||
      message.brandId !== this.brand ||
      !isPracticeAddress(message.to)
    )
      return 'rejected';
    const signature = createHash('sha256')
      .update(
        JSON.stringify([
          message.to,
          message.subject,
          message.html,
          message.text,
          message.images.map(({ name, mime, sha256 }) => [name, mime, sha256]),
        ]),
      )
      .digest('hex');
    await this.sql.query(
      `INSERT INTO delivery_test_receipts(workspace_id,brand_id,rehearsal_id,operation_key,message_digest)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [this.workspace, this.brand, this.rehearsal, message.operationKey, signature],
    );
    const receipt = await this.receipt(message.operationKey);
    if (receipt !== signature) return 'unknown';
    return message.to === 'timeout@delivery.test' ? 'unknown' : 'accepted';
  }

  async lookup(operationKey: string): Promise<DeliveryOutcome> {
    // Our SQL submission and receipt are atomic under the worker lock. This test store
    // can prove nonacceptance after a rollback. External adapters cannot infer it from a 404.
    return (await this.receipt(operationKey)) ? 'accepted' : 'not_submitted';
  }

  private async receipt(key: string) {
    const { rows } = await this.sql.query<{ message_digest: string }>(
      'SELECT message_digest FROM delivery_test_receipts WHERE rehearsal_id=$1 AND operation_key=$2',
      [this.rehearsal, key],
    );
    return rows[0]?.message_digest;
  }
}
