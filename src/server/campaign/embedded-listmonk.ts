import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeliveryEnvelope } from './delivery-provider.js';
import { listmonkReference, listmonkTxForm } from './listmonk-callback.js';
import { isPracticeAddress } from './rehearsal.js';

type Ready = { port: number; templateId: number; token: string };
type Supervisor = { ready: Promise<Ready>; dispose(): Promise<void> };
const offline = () => Error('The private Listmonk rehearsal engine is unavailable.');

function endpoint(value: string) {
  return (
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/message$/.test(value) &&
    Number(value.split(':')[2]?.split('/')[0]) <= 65535
  );
}

// One disposable engine per binding. The application DB owns intents and receipts;
// this process never receives a DB connection, SES credentials, or customer addresses.
export class EmbeddedListmonk {
  private current?: Supervisor;
  private closed = false;
  private active = 0;
  private idle?: NodeJS.Timeout;
  private retiring?: Promise<void>;

  constructor(
    private callback: string,
    private callbackSecret: string,
  ) {
    if (
      !endpoint(callback) ||
      typeof callbackSecret !== 'string' ||
      callbackSecret.length < 16 ||
      /[\r\n]/.test(callbackSecret)
    ) {
      throw Error('A dedicated loopback Listmonk callback and secret are required.');
    }
  }

  private supervise(): Supervisor {
    const work = mkdtempSync(path.join(tmpdir(), 'flockletter-private-engine-'));
    let child: ChildProcess;
    try {
      const source = import.meta.url.endsWith('.ts');
      child = fork(new URL('./embedded-listmonk-child.' + (source ? 'ts' : 'js'), import.meta.url), [], {
        execArgv: source ? ['--import', 'tsx'] : [],
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { FLOCKLETTER_ENGINE_WORKDIR: work, TMPDIR: work, PATH: '/usr/bin:/bin', LANG: 'C' },
      });
    } catch {
      void rm(work, { recursive: true, force: true });
      throw offline();
    }
    let gone = false;
    const exited = new Promise<void>((resolve) => {
      const done = () => {
        gone = true;
        resolve();
      };
      child.once('error', done);
      child.once('exit', done);
    });
    let shutdown: Promise<void> | undefined;
    const runner: Supervisor = {
      ready: new Promise<Ready>((resolve, reject) => {
        const timer = setTimeout(() => reject(offline()), 120_000);
        const done = () => {
          clearTimeout(timer);
          reject(offline());
        };
        child.once('error', done);
        child.once('exit', done);
        child.once('message', (m: Partial<Ready> & { type?: string; phase?: string }) => {
          clearTimeout(timer);
          if (
            m.type !== 'ready' ||
            !Number.isSafeInteger(m.port) ||
            m.port! < 1 ||
            m.port! > 65535 ||
            !Number.isSafeInteger(m.templateId) ||
            m.templateId! < 1 ||
            !/^[0-9a-f]{64}$/.test(m.token ?? '')
          ) {
            // Only fixed phase labels may leave the supervisor. No child error, stderr or secret is logged.
            const phases = [
              'configuration',
              'database initialization',
              'database setup',
              'Listmonk install',
              'engine configuration',
              'engine listener',
            ];
            reject(
              phases.includes(m.phase ?? '')
                ? Error('Private Listmonk failed during ' + m.phase + '.')
                : offline(),
            );
          } else
            resolve({
              port: m.port!,
              templateId: m.templateId!,
              token: m.token!,
            });
        });
      }),
      dispose: () => {
        if (shutdown) return shutdown;
        shutdown = (async () => {
          if (child.connected) child.disconnect();
          // SIGKILL the dedicated process group if shutdown hangs or the supervisor dies
          // before it could stop Postgres, initdb, or Listmonk. No other service is in this group.
          const killGroup = () => {
            if (!child.pid) return;
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              /* group has already exited */
            }
          };
          if (!gone) {
            const timer = setTimeout(killGroup, 10_000);
            try {
              await exited;
            } finally {
              clearTimeout(timer);
            }
          }
          killGroup();
          try {
            await rm(work, { recursive: true, force: true });
          } finally {
            if (this.current === runner) this.current = undefined;
          }
        })();
        return shutdown;
      },
    };
    void exited.then(() => runner.dispose()).catch(() => {});
    child.send({ callback: this.callback, secret: this.callbackSecret }, (error) => {
      if (error) void runner.dispose().catch(() => {});
    });
    return runner;
  }

  async render(message: DeliveryEnvelope, reference: string): Promise<void> {
    if (
      this.closed ||
      !isPracticeAddress(message.to) ||
      reference !== listmonkReference(message.workspaceId, message.brandId, message.operationKey)
    ) {
      throw Error('Invalid or closed private Listmonk rehearsal.');
    }
    clearTimeout(this.idle);
    this.active++;
    try {
      await this.retiring;
      if (this.closed) throw offline();
      await this.post(message, reference);
    } finally {
      this.active--;
      const idleRunner = this.current;
      if (!this.closed && !this.active && idleRunner) {
        this.idle = setTimeout(() => {
          if (this.closed || this.active || idleRunner !== this.current) return;
          this.current = undefined;
          const retiring = (this.retiring = idleRunner.dispose());
          void retiring
            .catch(() => {})
            .finally(() => {
              if (this.retiring === retiring) this.retiring = undefined;
            });
        }, 180_000).unref();
      }
    }
  }

  private async post(message: DeliveryEnvelope, reference: string) {
    const runner = (this.current ??= this.supervise());
    let engine: Ready;
    try {
      engine = await runner.ready;
    } catch (error) {
      await runner.dispose();
      throw error;
    }
    if (this.closed) throw offline();
    const response = await fetch('http://127.0.0.1:' + engine.port + '/api/tx', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: 'token renderer:' + engine.token },
      body: listmonkTxForm(message, reference, engine.templateId, 'flockletter', true),
    });
    await response.body?.cancel();
    if (!response.ok) throw Error('Listmonk did not acknowledge the private handoff.');
    // Only the application's authenticated callback and durable receipt prove acceptance.
  }

  async close() {
    this.closed = true;
    clearTimeout(this.idle);
    await Promise.all([this.retiring, this.current?.dispose()]);
  }
}
