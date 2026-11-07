import { supportAnswer, supportAddress, type SupportTopic } from '../shared/support.js';
export function Help() {
  return (
    <main className="main" id="main">
      <section className="card">
        <h1 className="page-heading">Flockletter support</h1>
        <p>Email our support team for help with your account, billing or privacy requests.</p>
        <p>Our team may use AI to draft replies to common product questions. A person reviews those drafts and handles account-specific questions.</p>
        <a className="btn" href={'mailto:' + supportAddress}>
          Email support
        </a>
      </section>
      {(['plans', 'trial', 'audience', 'campaigns'] as SupportTopic[]).map((topic) => {
        const answer = supportAnswer(topic)!;
        return (
          <section className="card" key={topic}>
            <h2>{answer.title}</h2>
            <p>{answer.text}</p>
          </section>
        );
      })}
      <a href="/pricing">Plans and limits</a> · <a href="/studio-notices.txt">Newsletter Studio software notices</a>
    </main>
  );
}
