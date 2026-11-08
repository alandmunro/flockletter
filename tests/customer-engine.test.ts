import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { CustomerEnginePool } from '../src/server/customer-delivery/engine.js';
import type { DeliveryEnvelope } from '../src/server/campaign/delivery-provider.js';

it.skipIf(process.env.FLOCKLETTER_TEST_PRIVATE_ENGINE !== '1')(
  'renders two isolated customer workspaces through real disposable Listmonk and preserves images',
  async () => {
    const pool = new CustomerEnginePool(1);
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=',
      'base64',
    );
    const sample = (workspaceId: string): DeliveryEnvelope => ({
      workspaceId,
      brandId: randomUUID(),
      operationKey: randomUUID(),
      to: 'reader@campaign.test',
      subject: 'Captured original photo review',
      html: '<html><body><p>Original photo</p><img src="cid:photo.png" alt="Original photo"></body></html>',
      text: 'Original photo',
      images: [
        {
          name: 'photo.png',
          mime: 'image/png',
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    });
    try {
      await expect(pool.render(sample('org_customer_a'))).resolves.toBeUndefined();
      await expect(pool.render(sample('org_customer_b'))).resolves.toBeUndefined();
      await expect(pool.render(sample('org_customer_a'))).resolves.toBeUndefined();
    } finally {
      await pool.close();
    }
  },
  180000,
);

it('quiesces one exact renderer scope and reports only process-local evidence',async()=>{
 const pool=new CustomerEnginePool(1),workspace='org_quiesced';
 try{expect(await pool.quiesce(workspace)).toMatchObject({workspaceId:workspace,quiesced:true,processLocalOnly:true});
 expect(pool.inspect(workspace).quiesced).toBe(true);expect(pool.inspect('org_neighbor').quiesced).toBe(false);
 await expect(pool.render({workspaceId:workspace} as DeliveryEnvelope)).rejects.toThrow('quiesced');
 await expect(pool.quiesce('arbitrary/path')).rejects.toThrow('exact workspace');
 }finally{await pool.close();}
});
