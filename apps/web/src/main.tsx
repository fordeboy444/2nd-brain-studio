import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initTheme } from "./lib/theme.js";
import "./styles/tokens.css";
import "./styles/App.css";
import "./assets/fonts/fonts.css";

// Apply the stored theme BEFORE the first render so a reload with a stored
// non-default preference never flashes the other theme.
initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);