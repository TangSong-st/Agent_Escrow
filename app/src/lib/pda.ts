import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

const ESCROW_SEED_PREFIX = "escrow";

function toSeedBuffer(seed: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(seed);
  return buffer;
}

export function findEscrowPda(
  seed: bigint,
  maker: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED_PREFIX), maker.toBuffer(), toSeedBuffer(seed)],
    programId,
  );
}

export function findVaultAddress(escrowPda: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, escrowPda, true, TOKEN_PROGRAM_ID);
}
