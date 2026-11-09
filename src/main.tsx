import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "streamdown/styles.css";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { ConfirmProvider } from "./components/ui/confirm-dialog";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ErrorBoundary>
  </StrictMode>,
);
