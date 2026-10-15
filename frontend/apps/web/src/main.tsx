import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.js";
import { TooltipProvider } from "./components/ui/tooltip.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    {/* shadcn 的 Tooltip 系列（含 AI Elements 的 CheckpointTrigger）
        要求整棵树包在 TooltipProvider 里，否则渲染即抛错。 */}
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
