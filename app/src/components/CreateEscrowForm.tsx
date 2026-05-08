import { FormEvent, useEffect, useState, type ReactElement } from "react";
import { PublicKey } from "@solana/web3.js";

type CreateEscrowFormProps = {
  disabled: boolean;
  mintDecimals: number | null;
  onSubmit: (input: {
    receiver: string;
    verifier: string;
    mint: string;
    amount: string;
    deadline: string;
    seed: string;
  }) => Promise<void>;
};

function defaultDeadline(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60 * 1000);
  return localDate.toISOString().slice(0, 16);
}

export function CreateEscrowForm({ disabled, mintDecimals, onSubmit }: CreateEscrowFormProps): ReactElement {
  const [receiver, setReceiver] = useState("");
  const [verifier, setVerifier] = useState("");
  const [mint, setMint] = useState("");
  const [amount, setAmount] = useState("");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [seed, setSeed] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (seed.length === 0) {
      setSeed(Date.now().toString());
    }
  }, [seed.length]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      new PublicKey(receiver);
      new PublicKey(verifier);
      new PublicKey(mint);
      if (Number(amount) <= 0) {
        throw new Error("Amount must be greater than zero.");
      }
      if (seed.length === 0) {
        throw new Error("Seed is required.");
      }
      setError(null);
      await onSubmit({ receiver, verifier, mint, amount, deadline, seed });
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Create Escrow</h2>
        <p>Rule-driven settlement with a deterministic vault PDA.</p>
      </div>
      <form className="form-grid" onSubmit={handleSubmit}>
        <label>
          <span>Receiver Address</span>
          <input value={receiver} onChange={(event) => setReceiver(event.target.value)} placeholder="Receiver pubkey" />
        </label>
        <label>
          <span>Verifier Address</span>
          <input value={verifier} onChange={(event) => setVerifier(event.target.value)} placeholder="Verifier pubkey" />
        </label>
        <label>
          <span>Mint Address</span>
          <input value={mint} onChange={(event) => setMint(event.target.value)} placeholder="SPL mint pubkey" />
        </label>
        <label>
          <span>Amount {mintDecimals === null ? "(token units)" : `(token units, up to ${mintDecimals} decimals)`}</span>
          <input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1.0" />
        </label>
        <label>
          <span>Deadline</span>
          <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
        </label>
        <label>
          <span>Seed</span>
          <div className="seed-row">
            <input value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="Unique seed" />
            <button className="ghost-button" type="button" onClick={() => setSeed(Date.now().toString())}>
              Generate
            </button>
          </div>
        </label>
        {error !== null ? <p className="error-text">{error}</p> : null}
        {mintDecimals !== null ? <p className="helper-note">Current mint decimals: {mintDecimals}</p> : null}
        <button className="primary-button" disabled={disabled} type="submit">
          {disabled ? "Creating..." : "Create Escrow"}
        </button>
      </form>
    </section>
  );
}
