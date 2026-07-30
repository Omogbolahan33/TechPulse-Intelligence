import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 bg-black flex items-center justify-center p-6 z-[9999]">
          <div className="max-w-md w-full bg-white/5 border border-white/10 rounded-3xl p-8 text-center backdrop-blur-xl">
            <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <AlertTriangle className="text-red-500" size={32} />
            </div>
            
            <h2 className="font-serif italic text-2xl text-white mb-2">Intelligence Interrupted</h2>
            <p className="text-white/40 text-sm font-mono mb-8 leading-relaxed">
              We encountered an unexpected anomaly while processing your intelligence feed. 
              {this.state.error?.message && (
                <span className="block mt-2 p-2 bg-white/5 rounded border border-white/5 text-[10px] text-red-400/60 break-words">
                  Error: {this.state.error.message}
                </span>
              )}
            </p>

            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={this.handleReset}
                className="flex items-center justify-center gap-2 bg-white text-black py-3 rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-gray-200 transition-colors"
              >
                <RefreshCw size={14} />
                Retry
              </button>
              <button
                onClick={() => window.location.href = '/'}
                className="flex items-center justify-center gap-2 bg-white/10 text-white py-3 rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-white/20 transition-colors"
              >
                <Home size={14} />
                Home
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
