import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import type { AgentEscrow } from "../target/types/agent_escrow";

dotenv.config();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentEscrow as anchor.Program<AgentEscrow>;
  const escrow = new PublicKey(requiredEnv("ESCROW"));
  const verifier = provider.wallet.publicKey;

  const signature = await program.methods
    .confirmDelivery()
    .accountsPartial({
      escrow,
      verifier,
    })
    .rpc();

  console.log(`verifier=${verifier.toBase58()}`);
  console.log(`escrow=${escrow.toBase58()}`);
  console.log(`tx=${signature}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
