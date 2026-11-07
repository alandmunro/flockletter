import type { TemplateId } from '../shared/authoring.js';

type LayoutParts = { heading: string; photos: string; story: string; link: string };

// The content renderer escapes every fragment before passing it to the chosen fixed layout.
export function renderAuthoringLayout(
  layout: TemplateId | undefined,
  { heading, photos, story, link }: LayoutParts,
) {
  switch (layout) {
    case 'collection':
      return `<section style="border-top:4px solid #52654f;padding-top:18px">${heading}${story}<div style="margin:20px 0">${photos}</div>${link}</section>`;
    case 'appreciation':
      return `<section style="border-left:4px solid #b97c91;padding:4px 0 4px 20px">${heading}${story}${link}${photos}</section>`;
    case 'announcement':
      return `<section style="border-top:4px solid #943d59;padding-top:18px">${heading}${photos}${story}${link}</section>`;
    default:
      return heading + photos + story + link;
  }
}
