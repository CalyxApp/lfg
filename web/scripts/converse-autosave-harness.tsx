// Page for converse-autosave-check.mjs: the real <Converse>, under StrictMode like main.tsx.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { Converse } from "@/converse";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Converse onClose={() => ((window as unknown as { __closed: boolean }).__closed = true)} />
  </StrictMode>,
);
