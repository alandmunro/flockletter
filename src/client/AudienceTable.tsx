import { stateLabel, textStateLabel, type AudienceContact, type SpecialDate } from '../shared/audience.js';

const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(date: SpecialDate | null) {
  if (!date) return '-';
  return `${monthNames[date.month - 1]} ${date.day}${date.year ? ', ' + date.year : ''}`;
}
export function formatPhone(phone: string | null) {
  const digits = phone?.replace(/^\+1/, '') ?? '';
  return /^\d{10}$/.test(digits) ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : (phone ?? '');
}
export function displayName(contact: Pick<AudienceContact, 'firstName' | 'lastName'>) {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ');
}

export type DateColumns = { birthday: boolean; anniversary: boolean; anniversaryLabel: string };

/** Email status and text status are separate columns and never merged into one status (FL-AUD-020). */
export function AudienceTable({
  contacts,
  onSelect,
  dates = { birthday: false, anniversary: false, anniversaryLabel: 'Anniversary' },
}: {
  contacts: AudienceContact[];
  onSelect: (id: string) => void;
  dates?: DateColumns;
}) {
  if (contacts.length === 0) {
    return <p>No contacts match this view.</p>;
  }

  return (
    <div className="audience-table-scroll">
      <table>
        <caption className="sr-only">Audience contacts</caption>
        <thead>
          <tr>
            <th scope="col">Contact</th>
            <th scope="col">Email</th>
            <th scope="col">Texts</th>
            {dates.birthday && <th scope="col">Birthday</th>}
            {dates.anniversary && <th scope="col">{dates.anniversaryLabel}</th>}
            <th scope="col">Added</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact) => {
            const name = displayName(contact);
            return (
              <tr key={contact.id}>
                <td>
                  <button type="button" className="contact-link" onClick={() => onSelect(contact.id)}>
                    {name || contact.email || formatPhone(contact.phone)}
                  </button>
                  <span className="contact-sub">
                    {name && contact.email && <span>{contact.email}</span>}
                    {contact.phone && (contact.email || name) && <span>{formatPhone(contact.phone)}</span>}
                  </span>
                </td>
                <td>
                  {contact.state ? (
                    <span className={`contact-state state-${contact.state}`}>{stateLabel[contact.state]}</span>
                  ) : (
                    <span className="contact-none">No email</span>
                  )}
                </td>
                <td>
                  {contact.text === 'no_phone' ? (
                    <span className="contact-none">No phone</span>
                  ) : (
                    <span className={`contact-state text-${contact.text}`}>{textStateLabel[contact.text]}</span>
                  )}
                </td>
                {dates.birthday && <td>{formatDate(contact.birthday)}</td>}
                {dates.anniversary && <td>{formatDate(contact.anniversary)}</td>}
                <td>
                  <time dateTime={contact.createdAt}>
                    {new Date(contact.createdAt).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
