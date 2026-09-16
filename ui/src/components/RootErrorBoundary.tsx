// The last line of defence: a render error anywhere in the tree used to
// unmount the whole app to a black window, with the reason visible only in
// a debugger nobody had attached. This shows the reason where the user is.
import * as React from "react";

interface State {
  error: Error | null;
}

export default class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="root-error" role="alert">
        <h1>Sky Pie hit a bug</h1>
        <p>
          <button type="button" className="root-error-reload" onClick={() => window.location.reload()}>
            Reload the app
          </button>
          What went wrong:
        </p>
        <pre>{`${error.name}: ${error.message}\n\n${error.stack ?? ""}`}</pre>
      </div>
    );
  }
}
