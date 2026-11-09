import { Component, type ReactNode } from 'react';
import i18n from '../lib/i18n';
import { reportCrash } from '../lib/watch';

/**
 * A page that crashes while drawing: instead of a blank screen, a short message and « Réessayer »; the error goes to
 * the Doctor (lib/watch). Another page (`page` changes) starts clean.
 */
export class PageGuard extends Component<{ page: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    reportCrash(e);
  }
  componentDidUpdate(prev: { page: string }) {
    if (prev.page !== this.props.page && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card" role="alert" style={{ margin: 16 }}>
        <p>{i18n.t('common.pageCrashed')}</p>
        <button className="btn" onClick={() => this.setState({ failed: false })}>
          {i18n.t('common.retry')}
        </button>
      </div>
    );
  }
}
