import type { JSONContent } from '@tiptap/core';
import { studioRunSchema, type StudioRun } from '../../shared/studio.js';

export function inlineDocument(runs: StudioRun[]): JSONContent {
  const inline: JSONContent[] = [];
  for (const run of runs) {
    const marks = [
      ...(run.bold ? [{ type: 'bold' }] : []),
      ...(run.italic ? [{ type: 'italic' }] : []),
      ...(run.href ? [{ type: 'link', attrs: { href: run.href } }] : []),
    ];
    const parts = run.text.split('\n');
    parts.forEach((text, index) => {
      if (index) inline.push({ type: 'hardBreak', marks });
      if (text) inline.push({ type: 'text', text, marks });
    });
  }
  return { type: 'doc', content: [{ type: 'paragraph', content: inline }] };
}

const unsupported = () =>
  new Error('This text block contains unsupported content. Restore the last valid text to continue.');
const ordinaryAttrs = (attributes: JSONContent['attrs']) => !attributes || !Object.keys(attributes).length;

export function inlineRuns(doc: JSONContent): StudioRun[] {
  const line = doc.content?.[0];
  if (
    doc.type !== 'doc' ||
    !ordinaryAttrs(doc.attrs) ||
    doc.content?.length !== 1 ||
    line?.type !== 'paragraph' ||
    !ordinaryAttrs(line.attrs) ||
    line.marks?.length ||
    doc.marks?.length
  )
    throw unsupported();
  const runs: StudioRun[] = [];
  for (const node of line.content ?? []) {
    if (
      node.content ||
      !ordinaryAttrs(node.attrs) ||
      (node.type !== 'hardBreak' && (node.type !== 'text' || typeof node.text !== 'string'))
    )
      throw unsupported();
    const run: StudioRun = { text: node.type === 'hardBreak' ? '\n' : node.text! };
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold' || mark.type === 'italic') {
        if (!ordinaryAttrs(mark.attrs)) throw unsupported();
        run[mark.type] = true;
      } else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
        // Only the defaults supplied by the bundled link extension can be discarded.
        const { href, target, rel, class: styleClass, title, 'ses:no-track': noTrack, ...rest } = mark.attrs;
        if (
          Object.keys(rest).length ||
          (target != null && target !== '_blank') ||
          (rel != null && rel !== 'noopener noreferrer nofollow') ||
          styleClass ||
          title ||
          noTrack != null
        )
          throw unsupported();
        run.href = href;
      } else throw unsupported();
    }
    if (!studioRunSchema.safeParse(run).success) throw unsupported();
    const previous = runs.at(-1);
    if (
      previous &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.href === run.href
    )
      previous.text += run.text;
    else runs.push(run);
  }
  return runs;
}
