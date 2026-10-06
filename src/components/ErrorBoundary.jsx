import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('MicroClutch Error caught by Boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '30px',
          margin: '40px auto',
          maxWidth: '650px',
          background: 'var(--surface, #1e2438)',
          border: '1px solid var(--danger, #ef4444)',
          borderRadius: '12px',
          color: 'var(--text, #f0f2f5)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          textAlign: 'center'
        }}>
          <i className="fa-solid fa-triangle-exclamation" style={{ fontSize: '36px', color: 'var(--danger, #ef4444)', marginBottom: '16px' }}></i>
          <h2 style={{ fontSize: '18px', marginBottom: '8px', color: 'var(--text-h, #ffffff)' }}>Something went wrong in this view</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted, #888)', marginBottom: '16px', fontFamily: 'monospace' }}>
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '10px 20px',
              borderRadius: '8px',
              background: 'var(--accent, #395bc8)',
              color: 'var(--text-h, #ffffff)',
              border: 'none',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <i className="fa-solid fa-rotate-right" style={{ marginRight: '6px' }}></i> Reload View
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
