import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfirmProvider, ToastProvider } from "./components/ui";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </ToastProvider>,
);
