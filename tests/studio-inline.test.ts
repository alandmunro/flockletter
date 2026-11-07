import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { inlineDocument, inlineRuns } from '../src/client/studio/inline-document.js';

describe('bounded visual text editor', () => {
  it('round trips supported formatting, links, Unicode, empty lines and literal markup', () => {
    const runs = [
      { text: 'A ñ trail\n\n', bold: true },
      { text: '<script> & shirts', italic: true, href: 'https://example.org/shop' },
    ];
    expect(inlineRuns(inlineDocument(runs))).toEqual(runs);
    expect(inlineRuns(inlineDocument([]))).toEqual([]);
  });
  it('accepts the Tiptap defaults for a normal link while retaining the exact public address', () => {
    const link: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Shop',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.org/?edition=first',
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                    title: null,
                    class: null,
                    'ses:no-track': null,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(inlineRuns(link)).toEqual([{ text: 'Shop', href: 'https://example.org/?edition=first' }]);
    link.content![0]!.content![0]!.marks![0]!.attrs!['ses:no-track'] = true;
    expect(() => inlineRuns(link)).toThrow(/unsupported/i);
  });
  it.each([
    { type: 'doc', content: [{ type: 'unknown', content: [{ type: 'text', text: 'Keep me' }] }] },
    { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] },
    { type: 'doc', content: [{ type: 'paragraph', attrs: { style: 'color:red' } }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image' }] }] },
    {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stay', marks: [{ type: 'code' }] }] }],
    },
    {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Stay', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
          ],
        },
      ],
    },
  ] satisfies JSONContent[])(
    'rejects data outside the inline contract instead of dropping its contents',
    (doc) => {
      expect(() => inlineRuns(doc)).toThrow(/unsupported/i);
      expect(doc.content?.length).toBeGreaterThan(0);
    },
  );
});
