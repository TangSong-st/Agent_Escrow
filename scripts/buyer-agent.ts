import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import type { AgentEscrow } from "../target/types/agent_escrow";

dotenv.config();

const ESCROW_SEED_PREFIX = "escrow";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function findEscrowPda(seed: bigint, maker: PublicKey, programId: PublicKey): [PublicKey, number] {
  const seedBuffer = Buffer.alloc(8);
  seedBuffer.writeBigUInt64LE(seed);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED_PREFIX), maker.toBuffer(), seedBuffer],
    programId,
  );
}

async function main(): Promise<void> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentEscrow as anchor.Program<AgentEscrow>;
  const maker = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;

  const receiver = new PublicKey(requiredEnv("RECEIVER"));
  const verifier = new PublicKey(requiredEnv("VERIFIER"));
  const mint = new PublicKey(requiredEnv("MINT"));
  const amount = BigInt(requiredEnv("AMOUNT"));
  const deadline = BigInt(requiredEnv("DEADLINE"));
  const seed = process.env.SEED === undefined ? BigInt(Date.now()) : BigInt(process.env.SEED);

  const [escrowPda] = findEscrowPda(seed, maker.publicKey, program.programId);

  const signature = await program.methods
    .make(new BN(seed.toString()), new BN(amount.toString()), new BN(deadline.toString()))
    .accountsPartial({
      maker: maker.publicKey,
      receiver,
      verifier,
      mint,
    })
    .rpc();

  console.log(`escrow_pda=${escrowPda.toBase58()}`);
  console.log(`vault=auto-derived-from-escrow-and-mint`);
  console.log(`deadline=${deadline.toString()}`);
  console.log(`tx=${signature}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
