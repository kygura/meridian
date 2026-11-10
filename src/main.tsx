import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./ui/ui.css";
import "./shell/shell.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
