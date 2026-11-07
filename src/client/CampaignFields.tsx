import type { CampaignContent, AssetSummary } from '../shared/contracts.js';

export function CampaignFields({ value, assets, disabled, onChange, messageOnly = false }: {
  messageOnly?: boolean;
  value: CampaignContent;
  assets: AssetSummary[];
  disabled: boolean;
  onChange: (next: CampaignContent) => void;
}) {
  const update = (patch: Partial<CampaignContent>) => {
    onChange({ ...value, ...patch });
  };

  const toggleAsset = (assetId: string) => {
    const isSelected = value.assetIds.includes(assetId);

    update({
      assetIds: isSelected
        ? value.assetIds.filter((id) => id !== assetId)
        : [...value.assetIds, assetId],
    });
  };

  const atAssetLimit = value.assetIds.length >= 6;

  return (
    <div className="editor-fields">
      <fieldset disabled={disabled}>
        <legend>Message</legend>

        <div className="field-grid">
          <div className="field">
            <label htmlFor="campaign-title">Title</label>
            <input
              id="campaign-title"
              type="text"
              value={value.title}
              maxLength={120}
              onChange={(event) => update({ title: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="campaign-subject">Subject</label>
            <input
              id="campaign-subject"
              type="text"
              value={value.subject}
              maxLength={150}
              onChange={(event) => update({ subject: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="campaign-preheader">Preheader</label>
            <input
              id="campaign-preheader"
              type="text"
              value={value.preheader}
              maxLength={200}
              onChange={(event) => update({ preheader: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="campaign-from-name">From name</label>
            <input
              id="campaign-from-name"
              type="text"
              value={value.fromName}
              maxLength={100}
              onChange={(event) => update({ fromName: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="campaign-reply-to">Reply-to</label>
            <input
              id="campaign-reply-to"
              type="email"
              value={value.replyTo}
              maxLength={254}
              onChange={(event) => update({ replyTo: event.target.value })}
            />
          </div>
        </div>
      </fieldset>

      {messageOnly ? null : <><fieldset disabled={disabled}>
        <legend>Content</legend>

        <div className="field-grid">
          <div className="field">
            <label htmlFor="campaign-heading">Heading</label>
            <input
              id="campaign-heading"
              type="text"
              value={value.heading}
              maxLength={150}
              onChange={(event) => update({ heading: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="campaign-body">Body</label>
            <textarea
              id="campaign-body"
              rows={12}
              value={value.body}
              maxLength={12000}
              aria-describedby="campaign-body-help"
              onChange={(event) => update({ body: event.target.value })}
            />
            <p id="campaign-body-help" className="help">
              Body is plain text only. Line breaks are preserved in the preview.
            </p>
          </div>
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend>Call to action</legend>

        <div className="field-grid">
          <div className="field">
            <label htmlFor="campaign-cta-label">Button text</label>
            <input
              id="campaign-cta-label"
              type="text"
              value={value.ctaLabel}
              maxLength={60}
              onChange={(event) => update({ ctaLabel: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="campaign-cta-url">Link address</label>
            <input
              id="campaign-cta-url"
              type="url"
              value={value.ctaUrl}
              maxLength={2048}
              aria-describedby="campaign-cta-help"
              onChange={(event) => update({ ctaUrl: event.target.value })}
            />
          </div>
        </div>

        <p id="campaign-cta-help" className="help">
          Use a public HTTPS link. It will be included in the saved preview.
        </p>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend>Images</legend>

        {assets.length > 0 ? (
          <p id="campaign-assets-help" className="help">
            Select up to 6 images. Your selected images appear in the order you choose them.
          </p>
        ) : null}

        <div className="asset-options">
          {assets.length === 0 ? (
            <p className="help">No assets are available.</p>
          ) : (
            assets.map((asset) => {
              const checked = value.assetIds.includes(asset.id);

              return (
                <label key={asset.id} className="asset-option" htmlFor={`campaign-asset-${asset.id}`}>
                  <input
                    id={`campaign-asset-${asset.id}`}
                    type="checkbox"
                    value={asset.id}
                    checked={checked}
                    disabled={!checked && atAssetLimit}
                    onChange={() => toggleAsset(asset.id)}
                  />
                  {asset.name}
                </label>
              );
            })
          )}
        </div>
      </fieldset></>}
    </div>
  );
}
