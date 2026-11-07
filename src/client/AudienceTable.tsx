import { stateLabel, type AudienceContact } from '../shared/audience.js';

export function AudienceTable({
  contacts,
  onSelect,
}: {
  contacts: AudienceContact[];
  onSelect: (id: string) => void;
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
            <th scope="col">Email address</th>
            <th scope="col">Status</th>
            <th scope="col">Added</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact) => (
            <tr key={contact.id}>
              <td>
                <button type="button" className="contact-link" onClick={() => onSelect(contact.id)}>
                  {contact.email}
                </button>
              </td>
              <td>
                <span className={`contact-state state-${contact.state}`}>{stateLabel[contact.state]}</span>
              </td>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
