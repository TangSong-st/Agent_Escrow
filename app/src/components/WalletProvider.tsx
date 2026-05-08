import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import type { ReactElement, ReactNode } from "react";

const endpoint =
  import.meta.env.VITE_SOLANA_RPC_URL ??
  (import.meta.env.VITE_SOLANA_NETWORK === "devnet"
    ? "https://api.devnet.solana.com"
    : "http://127.0.0.1:8899");

const network = WalletAdapterNetwork.Devnet;

export function AppWalletProvider({ children }: { children: ReactNode }): ReactElement {
  const wallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network })];

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
