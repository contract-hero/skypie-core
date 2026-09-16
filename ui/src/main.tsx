import * as React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import RootErrorBoundary from "./components/RootErrorBoundary";
import { tauriIpc } from "./ipc";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App ipc={tauriIpc} />
    </RootErrorBoundary>
  </React.StrictMode>,
);
