import { request } from 'node:http';

export function postNativeForm(
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (parsed.protocol !== 'http:') {
      reject(new Error('protocol must be http:'));
      return;
    }

    if (parsed.hostname !== '127.0.0.1') {
      reject(new Error('hostname must be 127.0.0.1'));
      return;
    }

    const port = parsed.port ? parseInt(parsed.port, 10) : 80;
    if (!Number.isInteger(port) || port <= 0) {
      reject(new Error('port must be a positive integer'));
      return;
    }

    const req = request(parsed, { method: 'POST' }, (res) => {
      res.resume();

      res.on('end', () => {
        resolve(res.statusCode ?? 0);
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    const timeout = setTimeout(() => req.destroy(new Error('Native form test timed out.')), 5000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', (err) => {
      reject(err);
    });

    const body = new URLSearchParams(fields).toString();
    req.setHeader('content-type', 'application/x-www-form-urlencoded');
    for (const [key, value] of Object.entries(headers)) {
      req.setHeader(key, value);
    }
    req.end(body);
  });
}
