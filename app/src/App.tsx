import { useEffect, useState, type ReactElement } from "react";
import { BN } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getProgram, getReadonlyProgram, PROGRAM_ID } from "./lib/anchor";
import { findEscrowPda, findVaultAddress } from "./lib/pda";
import {
  buildCreateMintTransaction,
  buildMintToWalletTransaction,
  formatTokenAmount,
  getMintDecimals,
  getTokenBalance,
  getOrCreateAtaInstruction,
  parseTokenAmount,
} from "./lib/token";
import { ConfirmButton } from "./components/ConfirmButton";
import { CreateEscrowForm } from "./components/CreateEscrowForm";
import { EscrowStatus, type EscrowView, type RecentEscrowItem } from "./components/EscrowStatus";
import { ExecuteButton } from "./components/ExecuteButton";

function formatDeadline(timestamp: bigint): string {
  return new Date(Number(timestamp) * 1000).toLocaleString();
}

function getExplorerLink(signature: string, localnet: boolean): string | null {
  if (localnet) {
    return null;
  }
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function deriveStatus(confirmed: boolean, executed: boolean, deadline: bigint): EscrowView["currentState"] {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (executed) {
    return confirmed ? "Released" : "Refunded";
  }
  if (confirmed) {
    return "Confirmed";
  }
  if (now > deadline) {
    return "Refundable";
  }
  return "NotReady";
}

function deriveExecutionHint(confirmed: boolean, executed: boolean, deadline: bigint): string {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (executed) {
    return confirmed
      ? "Settlement already released to the receiver and the vault has been closed."
      : "Settlement already refunded to the maker and the vault has been closed.";
  }
  if (confirmed) {
    return "Ready to release to the receiver.";
  }
  if (now > deadline) {
    return "Ready to refund the maker.";
  }
  return "NotReady: waiting for verifier confirmation or deadline expiry.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatUiError(error: unknown, isLocalnet: boolean): string {
  const fallback = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "";
  const normalized = fallback.toLowerCase();

  if (errorName.includes("WalletSignTransactionError") || errorName.includes("WalletSendTransactionError")) {
    if (isLocalnet) {
      return "Wallet rejected the localnet transaction. In browser wallets, enable test networks or developer mode, switch the wallet to localnet support, and make sure this wallet has localnet SOL for fees.";
    }
    return "Wallet rejected the transaction. Check the wallet popup, selected network, and available SOL for fees.";
  }

  if (normalized.includes("0x1770") || normalized.includes("invalidamount")) {
    return "Amount must be greater than zero.";
  }
  if (normalized.includes("0x1771") || normalized.includes("invaliddeadline")) {
    return "Deadline must be later than the current on-chain time.";
  }
  if (normalized.includes("0x1772") || normalized.includes("notready")) {
    return "This escrow is not ready yet. It needs verifier confirmation or the deadline must pass first.";
  }
  if (normalized.includes("0x1773") || normalized.includes("unauthorizedverifier")) {
    return "Only the configured verifier wallet can confirm this escrow.";
  }
  if (normalized.includes("0x1774") || normalized.includes("alreadyexecuted")) {
    return "This escrow has already been executed.";
  }
  if (normalized.includes("0x1776") || normalized.includes("invalidvault")) {
    return "The vault account does not match this escrow.";
  }
  if (normalized.includes("insufficient funds")) {
    return "The wallet does not have enough SOL or tokens for this transaction.";
  }
  if (normalized.includes("failed to fetch") || normalized.includes("networkerror")) {
    return "Network request failed. Check the RPC connection and try again.";
  }

  if (isRecord(error) && "error" in error && typeof error.error === "string") {
    return error.error;
  }

  return fallback;
}

export function App(): ReactElement {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();

  const [escrowPdaInput, setEscrowPdaInput] = useState("");
  const [currentEscrow, setCurrentEscrow] = useState<EscrowView | null>(null);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [devMint, setDevMint] = useState<string>("");
  const [devMintAmount, setDevMintAmount] = useState("1");
  const [walletTokenBalance, setWalletTokenBalance] = useState<string>("0 tokens (0 raw)");
  const [walletTokenAccount, setWalletTokenAccount] = useState<string>("Not created yet");
  const [walletSolBalance, setWalletSolBalance] = useState<string>("0");
  const [transactionStage, setTransactionStage] = useState<string | null>(null);
  const [devMintDecimals, setDevMintDecimals] = useState<number | null>(null);
  const [recentEscrows, setRecentEscrows] = useState<RecentEscrowItem[]>([]);

  const rpcEndpoint = connection.rpcEndpoint;
  const isLocalnet = rpcEndpoint.includes("127.0.0.1") || rpcEndpoint.includes("localhost");
  const networkLabel = isLocalnet ? "localnet" : "devnet";
  const recentEscrowsStorageKey = `agent-escrow-recent-${networkLabel}`;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(recentEscrowsStorageKey);
      if (raw === null) {
        setRecentEscrows([]);
        return;
      }
      setRecentEscrows(JSON.parse(raw) as RecentEscrowItem[]);
    } catch {
      setRecentEscrows([]);
    }
  }, [recentEscrowsStorageKey]);

  function rememberEscrow(item: RecentEscrowItem): void {
    const next = [item, ...recentEscrows.filter((entry) => entry.escrowPda !== item.escrowPda)].slice(0, 8);
    setRecentEscrows(next);
    window.localStorage.setItem(recentEscrowsStorageKey, JSON.stringify(next));
  }

  async function submitTransaction(
    transaction: Transaction,
    extraSigners: Keypair[] = [],
    labels?: {
      awaitingApproval?: string;
      submitting?: string;
      confirming?: string;
    },
  ): Promise<string> {
    if (wallet.publicKey === null) {
      throw new Error("Connect a wallet first.");
    }
    if (wallet.signTransaction === undefined) {
      throw new Error("Current wallet does not support transaction signing.");
    }

    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;

    if (extraSigners.length > 0) {
      transaction.partialSign(...extraSigners);
    }

    setTransactionStage(labels?.awaitingApproval ?? "Waiting for wallet approval...");
    const signedTransaction = await wallet.signTransaction(transaction);
    setTransactionStage(labels?.submitting ?? "Submitting transaction...");
    const signatureValue = await connection.sendRawTransaction(signedTransaction.serialize());
    setTransactionStage(labels?.confirming ?? "Waiting for on-chain confirmation...");
    await connection.confirmTransaction(
      {
        signature: signatureValue,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    );
    setTransactionStage(null);
    return signatureValue;
  }

  async function refreshBalance(mintOverride?: string): Promise<void> {
    const activeMint = mintOverride ?? devMint;
    if (wallet.publicKey === null || activeMint.length === 0) {
      setWalletTokenBalance("0 tokens (0 raw)");
      setWalletTokenAccount("Not created yet");
      return;
    }
    try {
      const mint = new PublicKey(activeMint);
      const decimals = await getMintDecimals(connection, mint);
      const tokenAccount = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
      const balance = await getTokenBalance(connection, tokenAccount);
      setDevMintDecimals(decimals);
      setWalletTokenAccount(tokenAccount.toBase58());
      setWalletTokenBalance(`${formatTokenAmount(balance, decimals)} tokens (${balance.toString()} raw)`);
    } catch {
      setWalletTokenBalance("0 tokens (0 raw)");
      setWalletTokenAccount("Not created yet");
      setDevMintDecimals(null);
    }
  }

  async function refreshSolBalance(): Promise<void> {
    if (wallet.publicKey === null) {
      setWalletSolBalance("0");
      return;
    }

    const lamports = await connection.getBalance(wallet.publicKey, "confirmed");
    setWalletSolBalance((lamports / 1_000_000_000).toFixed(4));
  }

  useEffect(() => {
    void refreshBalance();
    void refreshSolBalance();
  }, [connection, devMint, signature, wallet.publicKey]);

  async function handleAirdropSol(): Promise<void> {
    if (!isLocalnet || wallet.publicKey === null) {
      return;
    }

    setLoadingAction("airdrop");
    setMessage(null);
    setSignature(null);
    setTransactionStage("Requesting localnet airdrop...");
    try {
      const signatureValue = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000);
      setTransactionStage("Confirming airdrop...");
      await connection.confirmTransaction(signatureValue, "confirmed");
      setSignature(signatureValue);
      setMessage("Airdropped 2 SOL to the connected localnet wallet.");
      await refreshSolBalance();
    } catch (error: unknown) {
      setMessage(formatUiError(error, isLocalnet));
    } finally {
      setTransactionStage(null);
      setLoadingAction(null);
    }
  }

  async function loadEscrowState(pdaOverride?: string): Promise<void> {
    const program = anchorWallet === undefined ? getReadonlyProgram(connection) : getProgram(connection, anchorWallet);

    const pda = pdaOverride ?? escrowPdaInput;
    setLoadingAction("load");
    setMessage(null);
    setSignature(null);
    try {
      const escrowPda = new PublicKey(pda);
      const account = await program.account.escrow.fetch(escrowPda);
      const mintDecimals = await getMintDecimals(connection, account.mint);
      const vault = findVaultAddress(escrowPda, account.mint);
      const deadline = BigInt(account.deadline.toString());
      const makerTokenAccount = getAssociatedTokenAddressSync(account.mint, account.maker, false, TOKEN_PROGRAM_ID);
      const receiverTokenAccount = getAssociatedTokenAddressSync(account.mint, account.receiver, false, TOKEN_PROGRAM_ID);
      const makerBalance = await getTokenBalance(connection, makerTokenAccount);
      const receiverBalance = await getTokenBalance(connection, receiverTokenAccount);
      const vaultBalance = await getTokenBalance(connection, vault);

      setCurrentEscrow({
        escrowPda: escrowPda.toBase58(),
        vault: vault.toBase58(),
        maker: account.maker.toBase58(),
        receiver: account.receiver.toBase58(),
        verifier: account.verifier.toBase58(),
        mint: account.mint.toBase58(),
        amount: account.amount.toString(),
        amountFormatted: `${formatTokenAmount(BigInt(account.amount.toString()), mintDecimals)} tokens`,
        mintDecimals,
        deadline: formatDeadline(deadline),
        confirmed: account.confirmed,
        executed: account.executed,
        currentState: deriveStatus(account.confirmed, account.executed, deadline),
        executionHint: deriveExecutionHint(account.confirmed, account.executed, deadline),
        makerBalance: `${formatTokenAmount(makerBalance, mintDecimals)} tokens`,
        receiverBalance: `${formatTokenAmount(receiverBalance, mintDecimals)} tokens`,
        vaultBalance: `${formatTokenAmount(vaultBalance, mintDecimals)} tokens`,
      });
      setEscrowPdaInput(escrowPda.toBase58());
      rememberEscrow({
        escrowPda: escrowPda.toBase58(),
        mint: account.mint.toBase58(),
        updatedAt: new Date().toLocaleString(),
        status: deriveStatus(account.confirmed, account.executed, deadline),
      });
      setMessage("Escrow state loaded.");
    } catch (error: unknown) {
      setMessage(formatUiError(error, isLocalnet));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleCreateEscrow(input: {
    receiver: string;
    verifier: string;
    mint: string;
    amount: string;
    deadline: string;
    seed: string;
  }): Promise<void> {
    if (wallet.publicKey === null || anchorWallet === undefined) {
      setMessage("Connect an Anchor-compatible wallet first.");
      return;
    }
    const program = getProgram(connection, anchorWallet);

    setLoadingAction("create");
    setMessage(null);
    setSignature(null);

    try {
      const receiver = new PublicKey(input.receiver);
      const verifier = new PublicKey(input.verifier);
      const mint = new PublicKey(input.mint);
      const mintDecimals = await getMintDecimals(connection, mint);
      const seed = BigInt(input.seed);
      const amount = parseTokenAmount(input.amount, mintDecimals);
      const deadlineTimestamp = BigInt(Math.floor(new Date(input.deadline).getTime() / 1000));
      const [escrowPda] = findEscrowPda(seed, wallet.publicKey, PROGRAM_ID);
      const createMakerAta = await getOrCreateAtaInstruction(connection, wallet.publicKey, mint, wallet.publicKey);

      if (createMakerAta.instruction !== null) {
        await submitTransaction(createMakerAta.instruction, [], {
          awaitingApproval: "Approve creation of your token account in the wallet...",
          submitting: "Creating token account...",
          confirming: "Confirming token account creation...",
        });
      }

      const transaction = await program.methods
        .make(new BN(seed.toString()), new BN(amount.toString()), new BN(deadlineTimestamp.toString()))
        .accountsPartial({
          maker: wallet.publicKey,
          receiver,
          verifier,
          mint,
        })
        .transaction();

      const tx = await submitTransaction(transaction, [], {
        awaitingApproval: "Approve escrow creation in the wallet...",
        submitting: "Submitting escrow creation transaction...",
        confirming: "Confirming escrow creation...",
      });
      setSignature(tx);
      setDevMint(mint.toBase58());
      setDevMintDecimals(mintDecimals);
      setEscrowPdaInput(escrowPda.toBase58());
      rememberEscrow({
        escrowPda: escrowPda.toBase58(),
        mint: mint.toBase58(),
        updatedAt: new Date().toLocaleString(),
        status: "NotReady",
      });
      setMessage(`Escrow created at ${escrowPda.toBase58()}`);
      await refreshBalance(mint.toBase58());
      await loadEscrowState(escrowPda.toBase58());
    } catch (error: unknown) {
      setMessage(formatUiError(error, isLocalnet));
    } finally {
      setTransactionStage(null);
      setLoadingAction(null);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (wallet.publicKey === null || anchorWallet === undefined || currentEscrow === null) {
      return;
    }
    const program = getProgram(connection, anchorWallet);

    setLoadingAction("confirm");
    setMessage(null);
    setSignature(null);
    try {
      const transaction = await program.methods
        .confirmDelivery()
        .accountsPartial({
          escrow: new PublicKey(currentEscrow.escrowPda),
          verifier: wallet.publicKey,
        })
        .transaction();
      const tx = await submitTransaction(transaction, [], {
        awaitingApproval: "Approve verifier confirmation in the wallet...",
        submitting: "Submitting verifier confirmation transaction...",
        confirming: "Confirming verifier transaction...",
      });
      setSignature(tx);
      setMessage("Delivery confirmed.");
      await loadEscrowState(currentEscrow.escrowPda);
    } catch (error: unknown) {
      setMessage(formatUiError(error, isLocalnet));
    } finally {
      setTransactionStage(null);
      setLoadingAction(null);
    }
  }

  async function handleExecute(): Promise<void> {
    if (wallet.publicKey === null || anchorWallet === undefined || currentEscrow === null) {
      return;
    }
    const program = getProgram(connection, anchorWallet);

    setLoadingAction("execute");
    setMessage(null);
    setSignature(null);
    try {
      const escrow = await program.account.escrow.fetch(new PublicKey(currentEscrow.escrowPda));
      const deadline = BigInt(escrow.deadline.toString());
      const status = deriveStatus(escrow.confirmed, escrow.executed, deadline);

      if (escrow.executed) {
        setMessage("This escrow has already been executed.");
        return;
      }

      if (!escrow.confirmed && status === "NotReady") {
        setMessage("This escrow is not ready yet. It needs verifier confirmation or the deadline must pass first.");
        return;
      }

      const mint = escrow.mint;
      const maker = escrow.maker;
      const receiver = escrow.receiver;
      const receiverAtaInstruction = await getOrCreateAtaInstruction(connection, wallet.publicKey, mint, receiver);
      const makerTokenAccount = getAssociatedTokenAddressSync(mint, maker, false, TOKEN_PROGRAM_ID);
      const receiverTokenAccount = getAssociatedTokenAddressSync(mint, receiver, false, TOKEN_PROGRAM_ID);

      if (receiverAtaInstruction.instruction !== null) {
        await submitTransaction(receiverAtaInstruction.instruction, [], {
          awaitingApproval: "Approve receiver token account creation in the wallet...",
          submitting: "Creating receiver token account...",
          confirming: "Confirming receiver token account creation...",
        });
      }

      const transaction = await program.methods
        .checkAndExecute()
        .accountsStrict({
          caller: wallet.publicKey,
          escrow: new PublicKey(currentEscrow.escrowPda),
          maker,
          receiver,
          mint,
          makerTokenAccount,
          receiverTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          vault: findVaultAddress(new PublicKey(currentEscrow.escrowPda), mint),
        })
        .transaction();

      const tx = await submitTransaction(transaction, [], {
        awaitingApproval: "Approve settlement execution in the wallet...",
        submitting: "Submitting settlement execution transaction...",
        confirming: "Confirming settlement execution...",
      });
      setSignature(tx);
      setMessage(escrow.confirmed ? "Settlement released to the receiver." : "Settlement refunded to the maker.");
      await loadEscrowState(currentEscrow.escrowPda);
    } catch (error: unknown) {
      setMessage(formatUiError(error, isLocalnet));
    } finally {
      setTransactionStage(null);
      setLoadingAction(null);
    }
  }

  async function handleCreateDevMint(): Promise<void> {
    if (wallet.publicKey === null) {
      setMessage("Connect a wallet first.");
      return;
    }

    setLoadingAction("createMint");
    setMessage(null);
    setSignature(null);
    try {
      const { mint, transaction } = await buildCreateMintTransaction(connection, wallet.publicKey, wallet.publicKey, 6);
      const signatureValue = await submitTransaction(transaction, [mint], {
        awaitingApproval: "Approve dev mint creation in the wallet...",
        submitting: "Submitting dev mint transaction...",
        confirming: "Confirming dev mint creation...",
      });
      setDevMint(mint.publicKey.toBase58());
      setDevMintDecimals(6);
      setSignature(signatureValue);
      setMessage(`Dev mint created: ${mint.publicKey.toBase58()}`);
      await refreshBalance(mint.publicKey.toBase58());
    } catch (error: unknown) {
      setMessage(formatUiError(error, isLocalnet));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleMintToWallet(): Promise<void> {
    if (wallet.publicKey === null || devMint.length === 0) {
      setMessage("Create or provide a mint first.");
      return;
    }

    setLoadingAction("mintToWallet");
    setMessage(null);
    setSignature(null);
    try {
      const { transaction } = await buildMintToWalletTransaction(
        connection,
        wallet.publicKey,
        new PublicKey(devMint),
        wallet.publicKey,
        wallet.publicKey,
        parseTokenAmount(devMintAmount, devMintDecimals ?? 0),
      );
      const signatureValue = await submitTransaction(transaction, [], {
        awaitingApproval: "Approve token minting in the wallet...",
        submitting: "Submitting token mint transaction...",
        confirming: "Confirming token mint transaction...",
      });
      setSignature(signatureValue);
      setMessage("Test tokens minted to current wallet.");
      await refreshBalance();
    } catch (error: unknown) {
      setMessage(formatUiError(error, isLocalnet));
    } finally {
      setTransactionStage(null);
      setLoadingAction(null);
    }
  }

  const canConfirm =
    currentEscrow !== null &&
    wallet.publicKey !== null &&
    wallet.publicKey.toBase58() === currentEscrow.verifier &&
    !currentEscrow.executed;

  const confirmHint =
    currentEscrow === null
      ? "Load an escrow first."
      : wallet.publicKey === null
        ? "Connect the verifier wallet to confirm."
        : wallet.publicKey.toBase58() !== currentEscrow.verifier
          ? "Current wallet is not the configured verifier."
          : currentEscrow.executed
            ? "This escrow is already executed."
            : "Verifier wallet is authorized to confirm.";

  const executeHint =
    currentEscrow === null
      ? "Load an escrow first."
      : currentEscrow.executionHint;

  const explorerLink = signature === null ? null : getExplorerLink(signature, isLocalnet);
  const modalOpen = transactionStage !== null || message !== null || signature !== null;
  const modalTone = transactionStage !== null ? "progress" : message !== null && message.toLowerCase().includes("rejected")
    ? "error"
    : message !== null &&
        (message.toLowerCase().includes("not ready") ||
          message.toLowerCase().includes("must") ||
          message.toLowerCase().includes("failed") ||
          message.toLowerCase().includes("does not") ||
          message.toLowerCase().includes("already"))
      ? "error"
      : "success";

  function closeModal(): void {
    if (transactionStage !== null) {
      return;
    }
    setMessage(null);
    setSignature(null);
  }

  return (
    <main className="app-shell">
      {modalOpen ? (
        <div
          aria-hidden={transactionStage !== null ? "true" : undefined}
          className="modal-backdrop"
          onClick={() => closeModal()}
          role="presentation"
        >
          <section
            aria-busy={transactionStage !== null}
            aria-live="polite"
            className={`feedback-modal feedback-modal-${modalTone}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="feedback-modal-header">
              <div>
                <p className="feedback-modal-eyebrow">
                  {transactionStage !== null
                    ? "Transaction In Progress"
                    : modalTone === "error"
                      ? "Action Needs Attention"
                      : "Action Completed"}
                </p>
                <h2>
                  {transactionStage !== null
                    ? "Working on your request"
                    : modalTone === "error"
                      ? "Something needs fixing"
                      : "Update from Agent Escrow"}
                </h2>
              </div>
              {transactionStage === null ? (
                <button aria-label="Close notification" className="modal-close-button" onClick={() => closeModal()} type="button">
                  Close
                </button>
              ) : null}
            </div>

            {transactionStage !== null ? (
              <div className="modal-stage-row">
                <span className="modal-spinner" />
                <p>{transactionStage}</p>
              </div>
            ) : null}

            {message !== null ? <p className="modal-message">{message}</p> : null}

            {signature !== null ? (
              <div className="modal-signature-block">
                <p className="helper-note">Transaction signature</p>
                {explorerLink === null ? (
                  <code>{signature}</code>
                ) : (
                  <a href={explorerLink} rel="noreferrer" target="_blank">
                    View transaction on Solana Explorer
                  </a>
                )}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      <section className="hero">
        <div>
          <p className="eyebrow">Agent Escrow</p>
          <h1>Permissionless execution, deterministic settlement.</h1>
          <p className="hero-copy">
            Funds live in a PDA-controlled SPL vault. Keepers can execute, verifiers can confirm, and the contract
            decides who gets paid.
          </p>
        </div>
        <div className="hero-side">
          <WalletMultiButton />
        <div className="wallet-meta">
          <span>Network: {networkLabel}</span>
          <span>Wallet: {wallet.publicKey?.toBase58() ?? "Not connected"}</span>
          <span>{wallet.publicKey === null ? "Connect wallet to transact." : "Wallet connected and ready for signing."}</span>
        </div>
        </div>
      </section>

      <section className="dev-tools">
        <div className="panel">
          <div className="panel-heading">
            <h2>Dev Token Helper</h2>
            <p>Create a test mint, mint tokens to your wallet, and inspect the current token balance.</p>
          </div>
          <div className="dev-grid">
            <label>
              <span>Mint Address</span>
              <input value={devMint} onChange={(event) => setDevMint(event.target.value)} placeholder="Mint pubkey" />
            </label>
            <label>
              <span>Mint Amount {devMintDecimals === null ? "(token units)" : `(token units, up to ${devMintDecimals} decimals)`}</span>
              <input
                value={devMintAmount}
                onChange={(event) => setDevMintAmount(event.target.value)}
                placeholder="1.0"
              />
            </label>
          </div>
          <div className="button-row">
            <button className="ghost-button" disabled={loadingAction !== null} onClick={() => void handleCreateDevMint()} type="button">
              {loadingAction === "createMint" ? "Creating Mint..." : "Create Dev Mint"}
            </button>
            <button className="ghost-button" disabled={loadingAction !== null} onClick={() => void handleMintToWallet()} type="button">
              {loadingAction === "mintToWallet" ? "Minting..." : "Mint Test Token"}
            </button>
            <button className="ghost-button" disabled={loadingAction !== null} onClick={() => void refreshBalance()} type="button">
              Refresh Balance
            </button>
            {isLocalnet ? (
              <button className="ghost-button" disabled={loadingAction !== null || wallet.publicKey === null} onClick={() => void handleAirdropSol()} type="button">
                {loadingAction === "airdrop" ? "Airdropping..." : "Airdrop 2 SOL"}
              </button>
            ) : null}
          </div>
          <p className="helper-note">Current wallet SOL balance: {walletSolBalance}</p>
          <p className="helper-note">Current mint decimals: {devMintDecimals ?? "Unknown"}</p>
          <p className="helper-note">Current wallet token balance: {walletTokenBalance}</p>
          <p className="helper-note">Current token account: {walletTokenAccount}</p>
          {isLocalnet ? (
            <p className="helper-note">
              Localnet tip: browser wallets often require test-network or developer-mode support before they will sign localhost transactions.
            </p>
          ) : null}
        </div>
      </section>

      <section className="content-grid">
        <CreateEscrowForm disabled={loadingAction === "create"} mintDecimals={devMintDecimals} onSubmit={handleCreateEscrow} />
        <EscrowStatus
          escrow={currentEscrow}
          escrowPdaInput={escrowPdaInput}
          loading={loadingAction === "load"}
          onEscrowPdaInputChange={setEscrowPdaInput}
          onLoad={loadEscrowState}
          recentEscrows={recentEscrows}
          onSelectRecent={loadEscrowState}
        />
      </section>

      <section className="action-row">
        <ConfirmButton disabled={loadingAction === "confirm"} canConfirm={canConfirm} hint={confirmHint} onClick={handleConfirm} />
        <ExecuteButton disabled={loadingAction === "execute" || currentEscrow === null} hint={executeHint} onClick={handleExecute} />
      </section>
    </main>
  );
}
