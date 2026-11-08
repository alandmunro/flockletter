import type { AssetSummary, CampaignContent } from './contracts.js';
import {
  studioAssetIds,
  studioLeaves,
  studioSchema,
  type StudioBlock,
  type StudioDocument,
  type StudioLeaf,
} from './studio.js';

// PostgreSQL JSON rejects an unpaired surrogate. Do not split an emoji at a legacy field boundary.
const limited = (value: string, max: number) => value.slice(0, max).replace(/[\uD800-\uDBFF]$/u, '');
const words = (value: string) => (value ? [{ text: value }] : []);
// Preserve the order of the existing template renderer, including original product photo order.
export function legacyToStudio(
  content: CampaignContent,
  assets: Pick<AssetSummary, 'id' | 'name'>[] = [],
): StudioDocument {
  if (content.studio !== undefined) return studioSchema.parse(content.studio);
  const heading: StudioLeaf = { type: 'heading', level: 1, runs: words(content.heading) };
  const body: StudioLeaf = { type: 'paragraph', runs: words(content.body) };
  const photos: StudioLeaf[] = content.assetIds.map((assetId) => ({
    type: 'image',
    assetId,
    alt: assets.find((a) => a.id === assetId)?.name ?? '',
  }));
  const link: StudioLeaf[] =
    content.ctaLabel || content.ctaUrl
      ? [{ type: 'button', label: content.ctaLabel, href: content.ctaUrl }]
      : [];
  let blocks: StudioBlock[];
  switch (content.layout) {
    case 'appreciation':
      blocks = [heading, body, ...link, ...photos];
      break;
    case 'collection':
      blocks = [heading, body, ...photos, ...link];
      break;
    default:
      blocks = [heading, ...photos, body, ...link];
  }
  return { version: 1, blocks };
}

// Older readers still receive the classic fields. Only the versioned blocks are authoritative for a Studio revision.
export function withStudio(content: CampaignContent, studio: StudioDocument): CampaignContent {
  const leaves = studioLeaves(studio);
  const heading = leaves.find((b) => b.type === 'heading');
  const button = leaves.find((b) => b.type === 'button');
  const body = leaves
    .filter((b) => b.type === 'paragraph')
    .map((b) => b.runs.map((r) => r.text).join(''))
    .join('\n\n');
  return {
    ...content,
    studio,
    assetIds: studioAssetIds(studio),
    heading: limited(heading?.runs.map((r) => r.text).join('') ?? '', 150),
    body: limited(body, 12000),
    ctaLabel: limited(button?.label ?? '', 60),
    ctaUrl: button?.href ?? '',
  };
}
