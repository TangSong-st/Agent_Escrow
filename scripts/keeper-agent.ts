import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import type { AgentEscrow } from "../target/types/agent_escrow";

dotenv.config();

async function main(): Promise<void> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentEscrow as anchor.Program<AgentEscrow>;
  const escrowEnv = process.env.ESCROW;
  if (escrowEnv === undefined || escrowEnv.length === 0) {
    throw new Error("Missing required environment variable: ESCROW");
  }
  const escrow = new PublicKey(escrowEnv);
  const escrowState = await program.account.escrow.fetch(escrow);
  const mint = escrowState.mint;
  const maker = escrowState.maker;
  const receiver = escrowState.receiver;
  const makerTokenAccount = getAssociatedTokenAddressSync(mint, maker, false, TOKEN_PROGRAM_ID);
  const receiverTokenAccount = getAssociatedTokenAddressSync(mint, receiver, false, TOKEN_PROGRAM_ID);
  const vault = getAssociatedTokenAddressSync(mint, escrow, true, TOKEN_PROGRAM_ID);

  const signature = await program.methods
    .checkAndExecute()
    .accountsStrict({
      caller: provider.wallet.publicKey,
      escrow,
      maker,
      receiver,
      mint,
      makerTokenAccount,
      receiverTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      vault,
    })
    .rpc();

  console.log("Permissionless execution submitted.");
  console.log(`keeper=${provider.wallet.publicKey.toBase58()}`);
  console.log(`escrow=${escrow.toBase58()}`);
  console.log(`tx=${signature}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
