import { useState } from 'react';
import './campaign-preview.css';

export function CampaignPreview({ html, title }: { html: string; title: string }) {
  const [size, setSize] = useState<'Desktop' | 'Mobile'>('Desktop');
  return (
    <div className="campaign-preview">
      <div role="group" aria-label="Preview width" className="preview-switch">
        {(['Desktop', 'Mobile'] as const).map((name) => (
          <button type="button" key={name} aria-pressed={size === name} onClick={() => setSize(name)}>
            {name}
          </button>
        ))}
      </div>
      <div className="preview-viewport" role="region" aria-label={size + ' email preview'}>
        <iframe
          className={'preview-frame ' + (size === 'Mobile' ? 'preview-mobile' : 'preview-desktop')}
          sandbox=""
          referrerPolicy="no-referrer"
          title={title}
          srcDoc={html}
        />
      </div>
    </div>
  );
}
