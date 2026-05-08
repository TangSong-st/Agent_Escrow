import type { ReactElement } from "react";
import { PublicKey } from "@solana/web3.js";

export type EscrowView = {
  escrowPda: string;
  vault: string;
  maker: string;
  receiver: string;
  verifier: string;
  mint: string;
  amount: string;
  amountFormatted: string;
  mintDecimals: number;
  deadline: string;
  confirmed: boolean;
  executed: boolean;
  currentState: "Released" | "Refunded" | "Confirmed" | "Refundable" | "NotReady";
  executionHint: string;
  makerBalance: string;
  receiverBalance: string;
  vaultBalance: string;
};

export type RecentEscrowItem = {
  escrowPda: string;
  mint: string;
  updatedAt: string;
  status: string;
};

type EscrowStatusProps = {
  escrowPdaInput: string;
  onEscrowPdaInputChange: (value: string) => void;
  onLoad: () => Promise<void>;
  loading: boolean;
  escrow: EscrowView | null;
  recentEscrows: RecentEscrowItem[];
  onSelectRecent: (escrowPda: string) => Promise<void>;
};

export function EscrowStatus({
  escrowPdaInput,
  onEscrowPdaInputChange,
  onLoad,
  loading,
  escrow,
  recentEscrows,
  onSelectRecent,
}: EscrowStatusProps): ReactElement {
  const isValid = (() => {
    try {
      new PublicKey(escrowPdaInput);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Escrow Status</h2>
        <p>Load on-chain state and see what execution would do right now.</p>
      </div>
      <div className="lookup-row">
        <input
          value={escrowPdaInput}
          onChange={(event) => onEscrowPdaInputChange(event.target.value)}
          placeholder="Escrow PDA"
        />
        <button className="primary-button" disabled={!isValid || loading} onClick={() => void onLoad()} type="button">
          {loading ? "Loading..." : "Load Escrow"}
        </button>
      </div>
      {recentEscrows.length > 0 ? (
        <div className="recent-list">
          <p className="helper-note">Recent escrows</p>
          {recentEscrows.map((item) => (
            <button className="recent-item" key={item.escrowPda} onClick={() => void onSelectRecent(item.escrowPda)} type="button">
              <span>{item.escrowPda}</span>
              <span>{item.status}</span>
              <span>{item.updatedAt}</span>
            </button>
          ))}
        </div>
      ) : null}
      {escrow !== null ? (
        <dl className="status-grid">
          <div>
            <dt>Maker</dt>
            <dd>{escrow.maker}</dd>
          </div>
          <div>
            <dt>Receiver</dt>
            <dd>{escrow.receiver}</dd>
          </div>
          <div>
            <dt>Verifier</dt>
            <dd>{escrow.verifier}</dd>
          </div>
          <div>
            <dt>Mint</dt>
            <dd>{escrow.mint}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{escrow.amountFormatted}</dd>
          </div>
          <div>
            <dt>Amount Raw</dt>
            <dd>{escrow.amount}</dd>
          </div>
          <div>
            <dt>Mint Decimals</dt>
            <dd>{escrow.mintDecimals}</dd>
          </div>
          <div>
            <dt>Deadline</dt>
            <dd>{escrow.deadline}</dd>
          </div>
          <div>
            <dt>Confirmed</dt>
            <dd>{String(escrow.confirmed)}</dd>
          </div>
          <div>
            <dt>Executed</dt>
            <dd>{String(escrow.executed)}</dd>
          </div>
          <div>
            <dt>Vault</dt>
            <dd>{escrow.vault}</dd>
          </div>
          <div>
            <dt>Maker Balance</dt>
            <dd>{escrow.makerBalance}</dd>
          </div>
          <div>
            <dt>Receiver Balance</dt>
            <dd>{escrow.receiverBalance}</dd>
          </div>
          <div>
            <dt>Vault Balance</dt>
            <dd>{escrow.vaultBalance}</dd>
          </div>
          <div>
            <dt>Current State</dt>
            <dd>{escrow.currentState}</dd>
          </div>
          <div>
            <dt>Execution Hint</dt>
            <dd>{escrow.executionHint}</dd>
          </div>
          <div>
            <dt>Escrow PDA</dt>
            <dd>{escrow.escrowPda}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
