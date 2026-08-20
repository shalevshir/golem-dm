// React entry, and nothing else. `index.html` already carries
// `<html dir="rtl" lang="he">`, so direction is set before any script runs
// rather than being patched in by React after first paint.
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element in index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
