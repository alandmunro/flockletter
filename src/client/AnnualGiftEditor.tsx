import { useEffect, useState } from 'react';
import type { Api } from './api.js';
import type { RecurringGift } from '../shared/date-automations.js';

export function AnnualGiftEditor({
  api,
  brandId,
  gift,
  change,
}: {
  api: Api;
  brandId: string;
  gift: RecurringGift;
  change: (value: RecurringGift) => void;
}) {
  const [amount,setAmount]=useState((gift.face/100).toFixed(2));
  const [catalog, setCatalog] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setCatalog([]);
    setError('');
    if (gift.face > 0)
      api
        .call<{ products: typeof catalog }>('gifts.catalog', { brandId, face: gift.face })
        .then((data) => {
          if (active) setCatalog(data.products);
        })
        .catch(() => {
          if (active) setError('Gift choices could not be loaded.');
        });
    return () => {
      active = false;
    };
  }, [api, brandId, gift.face]);
  return (
    <fieldset>
      <legend>Gift for each greeting</legend>
      <label>
        Gift amount (USD)
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            const value=e.target.value;
            const face=/^\d+(?:\.\d{0,2})?$/.test(value)?Math.round(Number(value)*100):0;
            if(face!==gift.face)change({...gift,face,products:[]});
          }}
        />
      </label>
      <label>
        Claim window
        <select
          value={gift.days}
          onChange={(e) => change({ ...gift, days: Number(e.target.value) as RecurringGift['days'] })}
        >
          {[15, 30, 60].map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Choose one brand or 5–10 brands</legend>
        {catalog.map((p) => (
          <label key={p.id}>
            <input
              type="checkbox"
              checked={gift.products.includes(p.id)}
              disabled={gift.products.length >= 10 && !gift.products.includes(p.id)}
              onChange={(e) =>
                change({
                  ...gift,
                  products: e.target.checked
                    ? [...gift.products, p.id]
                    : gift.products.filter((id) => id !== p.id),
                })
              }
            />
            {p.name}
          </label>
        ))}
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={gift.brokerConfirmed}
          onChange={(e) => change({ ...gift, brokerConfirmed: e.target.checked })}
        />
        My broker has approved these gifts, if required.
      </label>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
