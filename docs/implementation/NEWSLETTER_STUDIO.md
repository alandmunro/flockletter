# Newsletter Studio in staging

A Flockletter workspace owner or an editor with access to the selected brand can prepare a newsletter. A viewer can open its saved preview. The brand determines which original images can be selected. A campaign draft, preview, captured test message and externally delivered email are distinct states.

## Edit a campaign

1. In **Campaigns**, choose the brand if several are available. Select **+ New campaign** for an empty Studio canvas. For an existing classic campaign, template or FFA product draft, open the draft, then select **Open Newsletter Studio**. Conversion happens in your working copy. It follows the original template order and carries forward the brand image IDs in their original order.
2. Fill in the message title, subject, preheader, sender and reply-to address. Select an existing heading or paragraph in the canvas and edit it in place. Add bold, italic or a public HTTPS link. Pasting uses plain text. Finish or cancel a pending link change before saving.
3. Use the block palette to insert a paragraph, heading, image, button, divider, spacer or two-column layout. Each column can contain its own supported blocks. Choose an original from this brand’s library and give the image descriptive alternative text. Add new originals through **Image library**. Move blocks with the up and down controls. Removing a block requires confirmation.
4. Select **Save draft**. The notice identifies the saved version. Choose **Preview & check**, switch between **Desktop** and **Mobile**, then open **Plain-text version** to inspect that revision. Preview also saves valid pending edits. Review any content or workspace gaps under **Before you send**.
5. For an authorized rehearsal, the owner uses **Review capture**, checks the exact version, audience and time, and chooses **Approve capture**. A later saved revision needs a new review. **Open captured email** shows the captured result. [Staging capture procedure](CAMPAIGN_PILOT.md)

## Recover an edit

The Studio displays the saved version or **You have unsaved changes**. When an inline edit cannot be represented, it identifies the problem and keeps the last valid draft available. **Restore last valid block** drops the incomplete edit to that block. **Discard edits and reload saved version** replaces the entire working copy with the currently stored revision.

If another editor saved first, reload the current version and reapply the intended changes. If the response was lost, retry the identical save before editing again. The operation key makes a repeated save idempotent. If the stored document itself uses an unknown block type or version, the Studio preserves it and blocks writes. Reloading the same unsupported revision cannot repair it. Use a reader that supports that format before editing it again.

## Draft representation and rendering

Studio v1 stores Flockletter block data in the campaign’s existing versioned content. All authoring surfaces use the same commands and scoped brand asset references. The browser uses the headless React Email editor extensions for bounded text editing, with Flockletter controls for block layout and media. Opening an unknown format never converts it through Tiptap. The document is validated first. [API and MCP](API_MCP.md) · [Editor and redistribution](STUDIO_LICENSES.md)

For a Studio revision, the blocks determine the order of headings, text, buttons, images and columns. Classic heading, body and CTA fields remain a compatibility projection for existing integrations. Clients updating a Studio draft must preserve the complete block document and collect its ordered, distinct image IDs. Classic drafts can continue through their existing commands. A customer’s product description, photos, catalog and commerce settings remain owned by the source system.

With a Studio draft open, expand **Add original images** to upload JPEG, PNG or WebP files to the campaign’s own brand. After the files are saved, choose an Image block to place one. Uploading does not commit your draft edits. The standalone Image library also lets an owner select among their workspace’s brands.

A document supports up to 60 blocks including column layouts and their children, six image placements, 300 text runs, 24,000 text characters and 64 KiB of serialized content. A two-column layout holds leaf blocks in each column. Links use public HTTPS URLs.

The server renders the reviewed revision to email HTML and meaningful plain text. The HTML uses table layouts, inline styles and responsive column rules. Authored text and URL attributes are escaped. In a captured message, the content ID for an inline image derives from the original bytes. The plain-text version includes link destinations and image alternative text. Desktop and mobile browser previews show Flockletter’s rendering at those widths. Gmail, Outlook and native mobile email clients have independent rendering engines.

## Inspect a sample email

With the project dependencies installed, generate a fictional message at the command line.

```sh
node --import tsx scripts/listmonk-capture/studio-fixture.ts --eml > studio-example.eml
```

Open `studio-example.eml` in a mail client that supports local messages. It contains a plain-text alternative, rendered HTML and an inline PNG. Check column order at narrow width, button text and destination, the inline image, and the plain-text alternative. This command writes a file locally and has no network transport. The sample was parsed for valid MIME structure, matching image content ID and preserved literal template-like text. Representative mailbox results belong in the release evidence when observed. [Engine proof and verification procedure](LISTMONK_CAPTURE.md)

Add `--column-images` to repeat the same original in both columns. At desktop width, the full-width image occupies 552 pixels and each column image occupies 268 pixels. The HTML width attributes support clients that ignore image styles. At a 390-pixel viewport with responsive styles, the columns stack and all three placements use the available 358 pixels. [Client verification](VERIFICATION.md#newsletter-studio)
