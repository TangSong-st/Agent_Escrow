import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

export async function getOrCreateAtaInstruction(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
): Promise<{ address: PublicKey; instruction: Transaction | null }> {
  const address = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  const existing = await connection.getAccountInfo(address);
  if (existing !== null) {
    return { address, instruction: null };
  }

  const transaction = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer,
      address,
      owner,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  return { address, instruction: transaction };
}

export async function getTokenBalance(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<bigint> {
  try {
    const account = await getAccount(connection, tokenAccount, undefined, TOKEN_PROGRAM_ID);
    return account.amount;
  } catch {
    return 0n;
  }
}

export async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const mintAccount = await getMint(connection, mint, undefined, TOKEN_PROGRAM_ID);
  return mintAccount.decimals;
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) {
    return amount.toString();
  }

  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const paddedFraction = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return paddedFraction.length === 0 ? whole.toString() : `${whole.toString()}.${paddedFraction}`;
}

export function parseTokenAmount(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Amount must be a positive number.");
  }

  const [wholePart, fractionPart = ""] = normalized.split(".");
  if (fractionPart.length > decimals) {
    throw new Error(`Amount supports up to ${decimals} decimal places for this mint.`);
  }

  const whole = BigInt(wholePart);
  const paddedFraction = fractionPart.padEnd(decimals, "0");
  const fraction = paddedFraction.length === 0 ? 0n : BigInt(paddedFraction);
  return whole * 10n ** BigInt(decimals) + fraction;
}

export async function buildCreateMintTransaction(
  connection: Connection,
  payer: PublicKey,
  mintAuthority: PublicKey,
  decimals: number,
): Promise<{ mint: Keypair; transaction: Transaction }> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, decimals, mintAuthority, null, TOKEN_PROGRAM_ID),
  );
  return { mint, transaction };
}

export async function buildMintToWalletTransaction(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  mintAuthority: PublicKey,
  owner: PublicKey,
  amount: bigint,
): Promise<{ transaction: Transaction; tokenAccount: PublicKey }> {
  const { address, instruction } = await getOrCreateAtaInstruction(connection, payer, mint, owner);
  const transaction = instruction ?? new Transaction();
  transaction.add(createMintToInstruction(mint, address, mintAuthority, amount, [], TOKEN_PROGRAM_ID));
  return { transaction, tokenAccount: address };
}
