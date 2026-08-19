import type { JSX } from "react";
import { he } from "./i18n.js";

export function App(): JSX.Element {
  return <main>{he.app.title}</main>;
}
