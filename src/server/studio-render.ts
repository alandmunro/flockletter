import type { Campaign, Gap } from '../shared/contracts.js';
import {
  studioLeaves,
  studioProblem,
  validateStudioLink,
  type StudioBlock,
  type StudioDocument,
  type StudioLeaf,
  type StudioRun,
} from '../shared/studio.js';
import { AppError } from './errors.js';

// Encoded braces remain visible in the email but are never Listmonk template actions.
function html(value: string) {
  return value.replace(
    /[&<>"'{}]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' })[
        c
      ]!,
  );
}
const lineBreaks = (value: string) => html(value).replace(/\r\n?|\n/g, '<br>');
function formattedRun(run: StudioRun) {
  let value = lineBreaks(run.text);
  if (run.italic) value = '<em>' + value + '</em>';
  if (run.bold) value = '<strong>' + value + '</strong>';
  if (run.href)
    value =
      '<a style="color:#8b2944;text-decoration:underline" href="' + html(run.href) + '">' + value + '</a>';
  return value;
}
function plainRun(run: StudioRun) {
  return run.href && run.href !== run.text ? run.text + ' (' + run.href + ')' : run.text;
}
function leafText(block: StudioLeaf): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return block.runs.map(plainRun).join('');
    case 'button':
      return [block.label, block.href].filter(Boolean).join(' — ');
    case 'image':
      return block.alt;
    default:
      return '';
  }
}
const table = 'role="presentation" border="0" cellspacing="0" cellpadding="0"';
const align = 'align="left" valign="top"';
const emailWidth = 600;
const bodyPadding = 24;
const columnPadding = 8;
type Picture = { src: string; name: string };
function blockHtml(
  block: StudioBlock,
  images: Map<string, Picture>,
  accent: string,
  availableWidth: number,
): string {
  switch (block.type) {
    case 'heading': {
      const tag = 'h' + block.level;
      const size = [32, 24, 20][block.level - 1];
      return (
        '<' +
        tag +
        ' style="margin:0;color:#40202a;font-family:Georgia,serif;font-size:' +
        size +
        'px;line-height:1.25">' +
        block.runs.map(formattedRun).join('') +
        '</' +
        tag +
        '>'
      );
    }
    case 'paragraph':
      return (
        '<p style="margin:0;color:#302b2e;font:16px/1.6 Arial,sans-serif">' +
        block.runs.map(formattedRun).join('') +
        '</p>'
      );
    case 'button': {
      const label = html(block.label);
      if (!block.href) return '<span>' + label + '</span>';
      return (
        '<table ' +
        table +
        '><tr><td bgcolor="' +
        accent +
        '" style="padding:11px 18px;border-radius:4px"><a style="color:#fff;font:bold 15px Arial,sans-serif;text-decoration:none" href="' +
        html(block.href) +
        '">' +
        label +
        '</a></td></tr></table>'
      );
    }
    case 'image': {
      const asset = images.get(block.assetId);
      if (!asset)
        throw new AppError(422, 'image_unavailable', 'A Studio image is unavailable in this brand.');
      return (
        '<img src="' +
        html(asset.src) +
        '" alt="' +
        html(block.alt) +
        `" width="${availableWidth}" style="display:block;width:100%;max-width:100%;height:auto;border:0">`
      );
    }
    case 'divider':
      return (
        '<table ' +
        table +
        ' width="100%"><tr><td style="border-top:1px solid #ded4d7;font-size:1px;line-height:1px">&nbsp;</td></tr></table>'
      );
    case 'spacer': {
      const height = { small: 8, medium: 16, large: 32 }[block.size];
      return (
        '<table ' +
        table +
        ' width="100%"><tr><td height="' +
        height +
        '" style="height:' +
        height +
        'px;font-size:1px;line-height:' +
        height +
        'px">&nbsp;</td></tr></table>'
      );
    }
    case 'columns': {
      const columnWidth = Math.floor(availableWidth / block.columns.length) - columnPadding;
      return (
        '<table ' +
        table +
        ' width="100%" style="width:100%;table-layout:fixed"><tr>' +
        block.columns
          .map(
            (items, index) =>
              '<td ' +
              align +
              ' class="fl-column" width="50%" style="width:50%;padding-' +
              (index === 0 ? 'right' : 'left') +
              `:${columnPadding}px">` +
              rows(items, images, accent, columnWidth) +
              '</td>',
          )
          .join('') +
        '</tr></table>'
      );
    }
  }
}
function rows(blocks: StudioBlock[], images: Map<string, Picture>, accent: string, availableWidth: number) {
  return (
    '<table ' +
    table +
    ' width="100%" style="width:100%">' +
    blocks
      .map(
        (b) =>
          '<tr><td ' +
          align +
          ' style="padding:0 0 ' +
          (b.type === 'spacer' ? '0' : '12px') +
          '">' +
          blockHtml(b, images, accent, availableWidth) +
          '</td></tr>',
      )
      .join('') +
    '</table>'
  );
}
export function studioContentGaps(doc: StudioDocument): Gap[] {
  const error = studioProblem(doc);
  const gap = (code: string, title: string, detail: string): Gap => ({
    code,
    title,
    detail,
    area: 'content',
  });
  if (error) return [gap('studio_unsupported', 'Review the saved Studio format', error)];
  const leaves = studioLeaves(doc);
  const gaps: Gap[] = [];
  if (
    !['heading', 'paragraph'].every((kind) =>
      leaves.some((b) => b.type === kind && 'runs' in b && b.runs.some((r) => r.text.trim())),
    )
  )
    gaps.push(
      gap(
        'message_incomplete',
        'Add a heading and message',
        'Add a readable heading and paragraph in Newsletter Studio.',
      ),
    );
  if (leaves.some((b) => b.type === 'button' && (!b.label.trim() || !validateStudioLink(b.href))))
    gaps.push(
      gap('link_incomplete', 'Complete the button', 'Each button needs a label and a public HTTPS address.'),
    );
  if (
    doc.blocks.some(
      (b) =>
        b.type === 'columns' &&
        b.columns.some((col) => !col.some((item) => item.type === 'image' || leafText(item).trim())),
    )
  )
    gaps.push(
      gap(
        'studio_columns_empty',
        'Complete the columns',
        'Add content to both columns or remove the layout.',
      ),
    );
  return gaps;
}

export function renderStudio(campaign: Campaign, doc: StudioDocument, images: Map<string, Picture>) {
  const issue = studioProblem(doc);
  if (issue) throw new AppError(422, 'studio_unsupported', issue);
  const { content } = campaign;
  const accent =
    content.layout === 'collection' ? '#47624c' : content.layout === 'appreciation' ? '#813a53' : '#862445';
  const text = studioLeaves(doc)
    .map(leafText)
    .filter((s) => s.trim())
    .join('\n\n');
  const body = rows(doc.blocks, images, accent, emailWidth - bodyPadding * 2);
  const markup =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' +
    html(content.subject) +
    '</title><style>@media only screen and (max-width:480px){.fl-column{display:block!important;width:100%!important;padding:0!important}.fl-padding{padding:16px!important}}</style></head>' +
    '<body style="margin:0;background-color:#f7f4f5"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">' +
    html(content.preheader) +
    '</div>' +
    '<table ' +
    table +
    ' width="100%" bgcolor="#f7f4f5"><tr><td align="center">' +
    `<!--[if mso]><table role="presentation" width="${emailWidth}" align="center"><tr><td><![endif]-->` +
    '<table ' +
    table +
    ` width="100%" align="center" bgcolor="#ffffff" style="width:100%;max-width:${emailWidth}px;border-top:4px solid ` +
    accent +
    `"><tr><td class="fl-padding" style="padding:${bodyPadding}px">` +
    (content.fromName
      ? '<p style="margin:0 0 16px;color:#67545a;font:14px Arial,sans-serif">' +
        html(content.fromName) +
        '</p>'
      : '') +
    body +
    '</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>';
  return { campaignId: campaign.id, version: campaign.version, html: markup, text };
}
