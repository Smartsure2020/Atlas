/**
 * Atlas — application error boundary
 * ----------------------------------------------------------------------------
 * The last defence between a React render-time exception and a completely
 * blank Atlas. Wraps the whole app inside StrictMode so a component throwing
 * during render, effect setup, or lifecycle produces a visible, recoverable
 * failure — the shared ErrorState presentation — instead of an empty page.
 *
 * Recovery is a full reload: the boundary sits above routing, so we cannot
 * safely "retry" a subtree without knowing what caused the fault. A reload
 * throws away the corrupted React tree and starts fresh from the current URL.
 *
 * Privacy: only the error's own name and message reach the console; nothing
 * about submissions, extracted documents, or the signed-in user is logged.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./ui";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorName: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorName: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorName: error.name || "Error" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the log surface minimal — name + message only, plus the component
    // stack React itself has already assembled. Never log arbitrary props
    // or state, which may carry submission or document data.
    // eslint-disable-next-line no-console
    console.error(
      `[Atlas] Unhandled render error: ${error.name}: ${error.message}`,
      info.componentStack
    );
  }

  private handleReload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "var(--atlas-space-6)",
          background: "var(--atlas-bg)",
        }}
      >
        <div style={{ width: "100%", maxWidth: 520 }}>
          <ErrorState
            title="Atlas ran into an unexpected error"
            message="The application could not continue rendering. Reloading the page will start a fresh session; your unsaved work in this tab may be lost."
            onRetry={this.handleReload}
            retryLabel="Reload Atlas"
          />
        </div>
      </div>
    );
  }
}
