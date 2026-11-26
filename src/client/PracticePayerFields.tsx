import type { PracticePayer } from '../shared/texting-onboarding.js';

const fields = [
  { key: 'name', label: 'Billing name', max: 120 }, { key: 'street', label: 'Billing street', max: 120 },
  { key: 'city', label: 'Billing city', max: 60 }, { key: 'region', label: 'Billing state', max: 60 },
  { key: 'postalCode', label: 'Billing ZIP code', max: 16 }, { key: 'country', label: 'Two-letter billing country', max: 2 },
] as const;

export function PracticePayerFields({ value, onChange, disabled }: {
  value: PracticePayer; onChange: (value: PracticePayer) => void; disabled: boolean;
}) {
  return <details><summary>Practice checkout billing details</summary>
    <p>These fictional payer details start with your registered business address. A mismatch sends the practice payment for ownership review.</p>
    {fields.map(({key,label,max}) => <label key={key}>{label}<input type="text" value={value[key]}
      maxLength={max} disabled={disabled} onChange={e => onChange({...value,[key]:key === 'country' ? e.target.value.toUpperCase() : e.target.value})}/></label>)}
  </details>;
}
