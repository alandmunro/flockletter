import { useEffect, useState } from 'react';
import type { Api } from './api.js';

type Campaign = { id: string; title: string; face: number; open: number; expiresAt: string };
export function GiftCampaignPicker({
  api,
  brandId,
  value,
  onChange,
}: {
  api: Api;
  brandId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api
      .call<{ campaigns: Campaign[] }>('gifts.status', { brandId })
      .then((data) => {
        if (active)
          setCampaigns(data.campaigns.filter((c) => c.open > 0 && Date.parse(c.expiresAt) > Date.now()));
      })
      .catch(() => {
        if (active) setError('Funded gift campaigns could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [api, brandId]);
  return (
    <label>
      Funded gift campaign
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No gift attachment</option>
        {value && !campaigns.some((c) => c.id === value) && (
          <option value={value}>Previously selected campaign</option>
        )}
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title} · ${(c.face / 100).toFixed(2)} each
          </option>
        ))}
      </select>
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
