import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Header } from './App.js';

type Props = { children: ReactNode };
type State = { failed: boolean };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };
  static getDerivedStateFromError(): State {
    return { failed: true };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Keep error details out of rendered markup; the user can reload cleanly.
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        <Header />
        <main className="main">
          <section className="card" role="alert">
            <h1>Something went wrong</h1>
            <p>Flockletter hit an unexpected display error. Reload the page to continue where you left off.</p>
            <p>
              <button type="button" onClick={() => window.location.reload()}>
                Reload page
              </button>
            </p>
          </section>
        </main>
      </>
    );
  }
}
