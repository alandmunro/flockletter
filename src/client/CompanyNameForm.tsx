import { useId, useState, useRef } from 'react';
import { operationKey } from './api.js';

export function CompanyNameForm({
  label,
  action,
  initial = '',
  onSave,
}: {
  label: string;
  action: string;
  initial?: string;
  onSave: (name: string, key: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const keyRef = useRef(operationKey());

  return (
    <form
      className="company-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const name = value.trim();
        if (!name || pending) return;

        setPending(true);
        setError(null);

        try {
          await onSave(name, keyRef.current);
          const next = initial ? name : '';
          setValue(next);
          keyRef.current = operationKey();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not save company name.');
        } finally {
          setPending(false);
        }
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div>
        <input
          id={id}
          type="text"
          value={value}
          required
          maxLength={100}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            if (next !== value) keyRef.current = operationKey();
            setError(null);
          }}
        />
        <button
          type="submit"
          className="btn secondary"
          disabled={pending || !value.trim() || value.trim() === initial}
        >
          {pending ? 'Saving…' : action}
        </button>
      </div>
      {error ? (
        <p role="alert" className="notice error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
