import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PlatformWorkerHealth } from '../src/client/PlatformWorkerHealth.js';
import type { CustomerWorkerHeartbeat } from '../src/shared/customer-operations.js';

const freshHeartbeat: CustomerWorkerHeartbeat = {
  kind: 'dedicated',
  state: 'fresh',
  observedAt: '2026-11-08T00:00:00.000Z',
  startedAt: '2026-11-08T00:00:00.000Z',
  lastHeartbeat: '2026-11-08T00:00:00.000Z',
  stoppedAt: null,
  freshnessSeconds: 60,
};

it('renders fresh state with actual observed and lastHeartbeat dates', () => {
  const html = renderToStaticMarkup(createElement(PlatformWorkerHealth, { heartbeat: freshHeartbeat }));
  expect(html).toContain('Recent heartbeat');
  expect(html).toContain('Kind: dedicated');
  expect(html).toContain(freshHeartbeat.observedAt);
  expect(html).toContain(freshHeartbeat.lastHeartbeat!);
  expect(html).not.toContain('successful processing');
});

it('renders stale state', () => {
  const html = renderToStaticMarkup(createElement(PlatformWorkerHealth, { heartbeat: { ...freshHeartbeat, state: 'stale' } }));
  expect(html).toContain('Heartbeat expired');
});

it('renders stopped state', () => {
  const html = renderToStaticMarkup(createElement(PlatformWorkerHealth, { heartbeat: { ...freshHeartbeat, state: 'stopped' } }));
  expect(html).toContain('Worker reported stopped');
});

it('renders unknown state as Not verified', () => {
  const html = renderToStaticMarkup(createElement(PlatformWorkerHealth, { heartbeat: { ...freshHeartbeat, state: 'unknown' } }));
  expect(html).toContain('Not verified');
});

it('renders missing heartbeat as Not verified and does not claim stopped or recent', () => {
  const html = renderToStaticMarkup(createElement(PlatformWorkerHealth, { heartbeat: undefined }));
  expect(html).toContain('Not verified');
  expect(html).not.toContain('Worker reported stopped');
  expect(html).not.toContain('Recent heartbeat');
});

it('renders null heartbeat as Not verified and does not claim stopped or recent', () => {
  const html = renderToStaticMarkup(createElement(PlatformWorkerHealth, { heartbeat: null }));
  expect(html).toContain('Not verified');
  expect(html).not.toContain('Worker reported stopped');
  expect(html).not.toContain('Recent heartbeat');
});

it('includes snapshot sentence distinguishing queue progress', () => {
  const html = renderToStaticMarkup(createElement(PlatformWorkerHealth, { heartbeat: freshHeartbeat }));
  expect(html).toContain('Snapshot only; queue progress is shown separately.');
});
