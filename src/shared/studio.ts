import { z } from 'zod';
import { publicProductLink } from './public-link.js';

export const validateStudioLink = publicProductLink;
const printable = (value: string) => !/[\p{Cc}\p{Cs}]/u.test(value.replace(/[\n\r\t]/g, ''));
const text = (max: number) => z.string().max(max).refine(printable, 'Use printable text.');
const url = z.string().max(2048).refine(validateStudioLink, 'Use a public HTTPS link.');
export const studioRunSchema = z
  .object({
    text: text(12000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    href: url.optional(),
  })
  .strict();
const runs = z.array(studioRunSchema).max(200);
const leafTypes = [
  z.object({ type: z.literal('paragraph'), runs }).strict(),
  z
    .object({ type: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), runs })
    .strict(),
  z.object({ type: z.literal('button'), label: text(120), href: z.union([z.literal(''), url]) }).strict(),
  z.object({ type: z.literal('image'), assetId: z.uuid().toLowerCase(), alt: text(300) }).strict(),
  z.object({ type: z.literal('divider') }).strict(),
  z.object({ type: z.literal('spacer'), size: z.enum(['small', 'medium', 'large']) }).strict(),
] as const;
const leaf = z.discriminatedUnion('type', leafTypes);
const column = z.array(leaf).max(30);
const block = z.discriminatedUnion('type', [
  ...leafTypes,
  z.object({ type: z.literal('columns'), columns: z.tuple([column, column]) }).strict(),
]);
export type StudioRun = z.infer<typeof studioRunSchema>;
export type StudioLeaf = z.infer<typeof leaf>;
export type StudioBlock = z.infer<typeof block>;
const document = z.object({ version: z.literal(1), blocks: z.array(block).max(60) }).strict();
export type StudioDocument = z.infer<typeof document>;

export function studioLeaves(doc: StudioDocument): StudioLeaf[] {
  return doc.blocks.flatMap((item) => (item.type === 'columns' ? item.columns.flat() : [item]));
}

export function studioAssetIds(doc: StudioDocument): string[] {
  return [...new Set(studioLeaves(doc).flatMap((item) => (item.type === 'image' ? [item.assetId] : [])))];
}

export const studioSchema = document.superRefine((doc, ctx) => {
  const leaves = studioLeaves(doc);
  const add = (message: string) => ctx.addIssue({ code: 'custom', path: ['blocks'], message });
  if (leaves.length + doc.blocks.filter((b) => b.type === 'columns').length > 60)
    add('Use at most 60 blocks including columns.');
  if (leaves.filter((b) => b.type === 'image').length > 6)
    add('Use at most six image placements in a newsletter.');
  const spans = leaves.flatMap((b) => ('runs' in b ? b.runs : []));
  if (spans.length > 300 || spans.reduce((n, r) => n + r.text.length, 0) > 24000)
    add('Use at most 300 text runs and 24,000 characters.');
  if (new TextEncoder().encode(JSON.stringify(doc)).length > 65536)
    add('The Studio document must fit in 64 KiB.');
});

export function studioProblem(value: unknown): string | null {
  const checked = studioSchema.safeParse(value);
  if (checked.success) return null;
  const issue = checked.error.issues[0];
  const blockIndex =
    issue?.path[0] === 'blocks' && typeof issue.path[1] === 'number' ? issue.path[1] + 1 : null;
  const field = blockIndex === null ? 'Newsletter format' : 'Block ' + blockIndex;
  return (
    field +
    ' is unsupported or invalid. ' +
    (issue?.message ?? 'Review the saved document.') +
    ' The saved revision is preserved.'
  );
}

export function emptyStudio(): StudioDocument {
  return {
    version: 1,
    blocks: [
      { type: 'heading', level: 1, runs: [] },
      { type: 'paragraph', runs: [] },
    ],
  };
}
