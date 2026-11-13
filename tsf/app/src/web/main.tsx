/**
 * The web entry (DESIGN 11). CSS in a fixed order: pw-ui components, the app globals and layout, then each lot's own
 * file. No theme CSS is imported: the server inlines the active theme as `<style id="tsf-theme">` (T16), and the store
 * keeps that element last in `<head>`. Components import no CSS.
 */
import "@pw/ui/components.css";
import "./styles.css";
import "./common/markdown.css";
import "./pages/pages.css";
import "./agent/agent.css";
import "./navbar/navbar.css";
import "./settings/settings.css";
import "./factory/factory.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "@pw/ui/react";
import { App } from "./App.tsx";
import { startStore } from "./state/store.ts";

startStore();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
