import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Notice = { source: string; sha256: string };
type Dependency = { name: string; version: string; integrity: string; notices: Notice[] };

const inventory: { roots: string[]; packages: Dependency[] } = JSON.parse(
  readFileSync(new URL('../public/studio-dependencies.json', import.meta.url), 'utf8'),
);
const text = readFileSync(new URL('../public/studio-notices.txt', import.meta.url), 'utf8');
const record = (name: string) => {
  const match = inventory.packages.find((item) => item.name === name);
  if (!match) throw new Error('Missing notice entry for ' + name);
  return match;
};

describe('Newsletter Studio redistribution', () => {
  it('keeps the notice actually published with the pinned editor and credits its inline artwork', () => {
    const editor = record('@react-email/editor');
    const published = readFileSync(
      new URL('../node_modules/@react-email/editor/license.md', import.meta.url),
      'utf8',
    );
    expect(editor.version).toBe('1.8.1');
    expect(editor.notices).toContainEqual({
      source: 'license.md',
      sha256: createHash('sha256').update(published).digest('hex'),
    });
    expect(text).toContain(published);
    expect(published).toContain('Copyright 2026 Plus Five Five, Inc');
    expect(editor.notices.some((notice) => notice.source.includes('lucide-icons/lucide'))).toBe(true);
    expect(text).toContain('Cole Bemis');
  });
  it('retains additional authors and terms that package-level SPDX metadata cannot express', () => {
    expect(inventory.roots).toEqual(['@react-email/editor', '@tiptap/core', '@tiptap/extensions']);
    expect(record('prettier').notices.some((notice) => notice.source === 'THIRD-PARTY-NOTICES.md')).toBe(
      true,
    );
    expect(record('citty').notices.some((notice) => notice.source === 'dist/THIRD-PARTY-LICENSES.md')).toBe(
      true,
    );
    expect(record('tslib').notices.some((notice) => notice.source === 'CopyrightNotice.txt')).toBe(true);
    expect(
      record('react-remove-scroll-bar').notices.some((notice) =>
        notice.source.includes('theKashey/react-remove-scroll-bar'),
      ),
    ).toBe(true);
    for (const dependency of inventory.packages) {
      expect(dependency.notices.length).toBeGreaterThan(0);
      for (const notice of dependency.notices) expect(text).toContain('[SHA-256 ' + notice.sha256 + ']');
    }
  });
});
