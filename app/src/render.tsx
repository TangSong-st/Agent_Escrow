import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppWalletProvider } from "./components/WalletProvider";
import "./styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppWalletProvider>
      <App />
    </AppWalletProvider>
  </React.StrictMode>,
);
