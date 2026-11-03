import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Shell from "./components/Shell";
import { ToastProvider } from "./components/Toaster";
import { Empty } from "./components/bits";
import { AccountProvider } from "./lib/account";
import { ChainProvider } from "./lib/chain";
import { WalletProvider } from "./lib/wallet";
import Audit from "./pages/Audit";
import Portfolio from "./pages/Portfolio";
import Home from "./pages/Home";
import Docs from "./pages/Docs";
import Panel from "./pages/Panel";
import Round from "./pages/Round";
import Rounds from "./pages/Rounds";
import Vault from "./pages/Vault";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ChainProvider>
        <ToastProvider>
          <WalletProvider>
          <AccountProvider>
            <Shell>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/rounds" element={<Rounds />} />
                <Route path="/rounds/:id" element={<Round />} />
                <Route path="/vault" element={<Vault />} />
                <Route path="/portfolio" element={<Portfolio />} />
                <Route path="/panel" element={<Panel />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="/docs" element={<Docs />} />
                <Route path="/how" element={<Navigate to="/docs" replace />} />
                <Route path="*" element={<div className="wrap page"><Empty title="Page not found">There's nothing at this address.</Empty></div>} />
              </Routes>
            </Shell>
          </AccountProvider>
          </WalletProvider>
        </ToastProvider>
      </ChainProvider>
    </BrowserRouter>
  </StrictMode>,
);
