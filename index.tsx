import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import AuthGate from './components/AuthGate';

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ERROR_BOUNDARY_CAUGHT:', error.message, error.stack);
    console.error('COMPONENT_STACK:', info.componentStack);
  }
  render() {
    if (this.state.error) return <pre style={{color:'red',padding:20,whiteSpace:'pre-wrap'}}>{'CAUGHT: ' + this.state.error.message + '\n\n' + this.state.error.stack}</pre>;
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </React.StrictMode>
);
