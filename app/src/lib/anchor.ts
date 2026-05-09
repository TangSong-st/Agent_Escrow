import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import idlJson from "../idl/agent_escrow.json";
import type { AgentEscrow } from "../../../target/types/agent_escrow";

const idl = idlJson as AgentEscrow;

const LOCALNET_PROGRAM_ID = "57BUJreQSofWxLxi5y7hSPbh47puKqgNH3o1FCxAQrJ7";

export function isLocalnetEndpoint(endpoint: string): boolean {
  return endpoint.includes("127.0.0.1") || endpoint.includes("localhost");
}

export function getProgramId(connection: Connection): PublicKey {
  const configuredProgramId = import.meta.env.VITE_AGENT_ESCROW_PROGRAM_ID;
  if (typeof configuredProgramId === "string" && configuredProgramId.length > 0) {
    return new PublicKey(configuredProgramId);
  }

  return new PublicKey(isLocalnetEndpoint(connection.rpcEndpoint) ? LOCALNET_PROGRAM_ID : idlJson.address);
}

export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;

const readonlyKeypair = Keypair.generate();
const readonlyWallet: AnchorWallet = {
  publicKey: readonlyKeypair.publicKey,
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> =>
    transactions,
  signTransaction: async <T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> => transaction,
};

export function createAnchorProvider(
  connection: Connection,
  wallet: AnchorWallet,
): AnchorProvider {
  return new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

export function getProgram(connection: Connection, wallet: AnchorWallet): Program<AgentEscrow> {
  const provider = createAnchorProvider(connection, wallet);
  return new Program<AgentEscrow>({ ...idl, address: getProgramId(connection).toBase58() } as AgentEscrow, provider);
}

export function getReadonlyProgram(connection: Connection): Program<AgentEscrow> {
  const provider = createAnchorProvider(connection, readonlyWallet);
  return new Program<AgentEscrow>({ ...idl, address: getProgramId(connection).toBase58() } as AgentEscrow, provider);
}

export function toBn(value: bigint): BN {
  return new BN(value.toString());
}
