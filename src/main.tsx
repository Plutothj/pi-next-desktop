import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "streamdown/styles.css";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
