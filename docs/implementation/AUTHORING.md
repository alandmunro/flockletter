# Newsletter templates and product announcements

Open **Campaigns**, then **Start with a template or product**. Select the sending brand if your workspace has more than one. Each command opens an editable draft with the ordinary save and preview controls.

## Start with a newsletter layout

Choose **Newsletter template**, review the section order and select **Use this template**. Product announcement places the photo first, Seasonal collection introduces the story before a gallery, and Customer appreciation starts with a letter. Supply your sender, reply address and message before reviewing the draft. Existing drafts keep their original layout.

## Start with a published product

Choose **Published product**. Enter the product name, its public HTTPS page and the approved product description. Select up to six existing photos from that brand in the desired order. **Create product draft** copies the supplied text and adds a **View product** link. Flockletter uses the stored original photos.

## Use the same workflow from an assistant

Read the built-in catalogue with `template_list`. Use `campaign_fromTemplate` with a brand ID, template ID and operation key. Use `campaign_fromProduct` with a brand ID, operation key, product name, excerpt, product URL and the ordered asset IDs. With the corresponding read grant, `asset_list` returns assets already available to the brand. Both draft actions require `draft:write`. Reuse the same operation key and identical input after an uncertain response.

These commands return the same draft shape and enforce the same scope, image ownership, draft limit and replay rules as `campaign_create`. Coverage for FL-CAM-001, FL-API-001/003 and the Flockletter side of FL-API-004 is in `tests/authoring.test.ts`. The desktop browser check uploads a fictional photo, creates both drafts and checks the product link in the rendered preview. [Template picker](screenshots/authoring-templates.png) · [Product draft form](screenshots/authoring-product.png)
