import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// @testing-library/react only self-registers its afterEach(cleanup) when it
// detects a global `afterEach` (Jest-style globals). This project's vitest
// config sets `globals: false`, so without this, DOM from one component test
// leaks into the next test in the same file.
afterEach(() => {
  cleanup();
});
