import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { privateMessenger } from '../src/server/campaign/private-messenger.js';
import { AppError } from '../src/server/errors.js';

it('authenticates the private callback before parsing and acknowledges only a committed receipt', async () => {
  const receive = vi.fn(async (raw: unknown) => {
    if (!(raw && typeof raw === 'object' && 'reviewed' in raw))
      throw new AppError(409, 'engine_callback_mismatch', 'Mismatch');
  });
  const secret = 'synthetic-private-secret';
  const server = createServer(privateMessenger(secret, receive)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw Error('Expected a loopback listener.');
    const endpoint = 'http://127.0.0.1:' + addr.port + '/message';
    const send = (authorization: string, body: string, type = 'application/json') =>
      fetch(endpoint, { method: 'POST', headers: { authorization, 'content-type': type }, body });
    const correct = 'Basic ' + Buffer.from('flockletter:' + secret).toString('base64');
    expect((await send('Basic invalid', '{')).status).toBe(401);
    expect((await send(correct, '{}', 'text/plain')).status).toBe(415);
    expect((await send(correct, '{')).status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
    expect((await send(correct, '{}')).status).toBe(409);
    expect((await send(correct, '{"reviewed":true}')).status).toBe(200);
    expect((await fetch(endpoint + '/extra', { method: 'POST' })).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
