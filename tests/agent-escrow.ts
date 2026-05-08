import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  createAssociatedTokenAccountInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import type { AgentEscrow } from "../target/types/agent_escrow";

type EscrowAccount = Awaited<ReturnType<Program<AgentEscrow>["account"]["escrow"]["fetch"]>>;

const ESCROW_SEED_PREFIX = "escrow";

function findEscrowPda(seed: bigint, maker: PublicKey, programId: PublicKey): [PublicKey, number] {
  const seedBuffer = Buffer.alloc(8);
  seedBuffer.writeBigUInt64LE(seed);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED_PREFIX), maker.toBuffer(), seedBuffer],
    programId,
  );
}

function findVaultAddress(escrowPda: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, escrowPda, true, TOKEN_PROGRAM_ID);
}

async function airdrop(connection: Connection, recipient: PublicKey, sol = 2): Promise<void> {
  const signature = await connection.requestAirdrop(recipient, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
}

async function createAtaIfMissing(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  const account = await connection.getAccountInfo(ata);
  if (account === null) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
  }
  return ata;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getEscrow(
  program: Program<AgentEscrow>,
  escrowPda: PublicKey,
): Promise<EscrowAccount> {
  return program.account.escrow.fetch(escrowPda);
}

describe("agent-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentEscrow as Program<AgentEscrow>;
  const connection = provider.connection;
  const maker = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;

  let verifier: Keypair;
  let outsider: Keypair;
  let receiver: Keypair;
  let mint: PublicKey;
  let makerTokenAccount: PublicKey;
  let receiverTokenAccount: PublicKey;

  const mintDecimals = 6;
  const mintAmount = 1_000_000_000n;

  before(async () => {
    verifier = Keypair.generate();
    outsider = Keypair.generate();
    receiver = Keypair.generate();

    await Promise.all([
      airdrop(connection, verifier.publicKey),
      airdrop(connection, outsider.publicKey),
      airdrop(connection, receiver.publicKey),
    ]);

    mint = await createMint(
      connection,
      maker,
      maker.publicKey,
      null,
      mintDecimals,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
    );

    makerTokenAccount = await createAtaIfMissing(connection, maker, mint, maker.publicKey);
    receiverTokenAccount = await createAtaIfMissing(connection, maker, mint, receiver.publicKey);

    await mintTo(
      connection,
      maker,
      mint,
      makerTokenAccount,
      maker,
      mintAmount,
      [],
      undefined,
      TOKEN_PROGRAM_ID,
    );
  });

  it("release path", async () => {
    const seed = 1n;
    const amount = 250_000_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const [escrowPda] = findEscrowPda(seed, maker.publicKey, program.programId);
    const vault = findVaultAddress(escrowPda, mint);

    await program.methods
      .make(new BN(seed.toString()), new BN(amount.toString()), new BN(deadline.toString()))
      .accountsPartial({
        maker: maker.publicKey,
        receiver: receiver.publicKey,
        verifier: verifier.publicKey,
        mint,
      })
      .rpc();

    const receiverBefore = (await getAccount(connection, receiverTokenAccount, undefined, TOKEN_PROGRAM_ID)).amount;

    await program.methods
      .confirmDelivery()
      .accountsPartial({
        escrow: escrowPda,
        verifier: verifier.publicKey,
      })
      .signers([verifier])
      .rpc();

    await program.methods
      .checkAndExecute()
      .accountsStrict({
        caller: outsider.publicKey,
        escrow: escrowPda,
        maker: maker.publicKey,
        receiver: receiver.publicKey,
        mint,
        makerTokenAccount,
        receiverTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        vault,
      })
      .signers([outsider])
      .rpc();

    const receiverAfter = (await getAccount(connection, receiverTokenAccount, undefined, TOKEN_PROGRAM_ID)).amount;
    const escrow = await getEscrow(program, escrowPda);

    expect(receiverAfter - receiverBefore).to.equal(amount);
    expect(escrow.executed).to.equal(true);
    expect(escrow.confirmed).to.equal(true);
  });

  it("refund path", async () => {
    const seed = 2n;
    const amount = 175_000_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 2);
    const [escrowPda] = findEscrowPda(seed, maker.publicKey, program.programId);
    const vault = findVaultAddress(escrowPda, mint);

    await program.methods
      .make(new BN(seed.toString()), new BN(amount.toString()), new BN(deadline.toString()))
      .accountsPartial({
        maker: maker.publicKey,
        receiver: receiver.publicKey,
        verifier: verifier.publicKey,
        mint,
      })
      .rpc();

    const makerBefore = (await getAccount(connection, makerTokenAccount, undefined, TOKEN_PROGRAM_ID)).amount;
    const receiverBefore = (await getAccount(connection, receiverTokenAccount, undefined, TOKEN_PROGRAM_ID)).amount;

    await sleep(5_000);

    await program.methods
      .checkAndExecute()
      .accountsStrict({
        caller: outsider.publicKey,
        escrow: escrowPda,
        maker: maker.publicKey,
        receiver: receiver.publicKey,
        mint,
        makerTokenAccount,
        receiverTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        vault,
      })
      .signers([outsider])
      .rpc();

    const makerAfter = (await getAccount(connection, makerTokenAccount, undefined, TOKEN_PROGRAM_ID)).amount;
    const receiverAfter = (await getAccount(connection, receiverTokenAccount, undefined, TOKEN_PROGRAM_ID)).amount;
    const escrow = await getEscrow(program, escrowPda);

    expect(makerAfter - makerBefore).to.equal(amount);
    expect(receiverAfter).to.equal(receiverBefore);
    expect(escrow.executed).to.equal(true);
    expect(escrow.confirmed).to.equal(false);
  });

  it("not ready", async () => {
    const seed = 3n;
    const amount = 90_000_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const [escrowPda] = findEscrowPda(seed, maker.publicKey, program.programId);
    const vault = findVaultAddress(escrowPda, mint);

    await program.methods
      .make(new BN(seed.toString()), new BN(amount.toString()), new BN(deadline.toString()))
      .accountsPartial({
        maker: maker.publicKey,
        receiver: receiver.publicKey,
        verifier: verifier.publicKey,
        mint,
      })
      .rpc();

    try {
      await program.methods
        .checkAndExecute()
        .accountsStrict({
          caller: outsider.publicKey,
          escrow: escrowPda,
          maker: maker.publicKey,
          receiver: receiver.publicKey,
          mint,
          makerTokenAccount,
          receiverTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          vault,
        })
        .signers([outsider])
        .rpc();
      expect.fail("expected NotReady error");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).to.include("NotReady");
    }
  });

  it("unauthorized verifier", async () => {
    const seed = 4n;
    const amount = 80_000_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const [escrowPda] = findEscrowPda(seed, maker.publicKey, program.programId);
    const vault = findVaultAddress(escrowPda, mint);

    await program.methods
      .make(new BN(seed.toString()), new BN(amount.toString()), new BN(deadline.toString()))
      .accountsPartial({
        maker: maker.publicKey,
        receiver: receiver.publicKey,
        verifier: verifier.publicKey,
        mint,
      })
      .rpc();

    try {
      await program.methods
        .confirmDelivery()
        .accountsPartial({
          escrow: escrowPda,
          verifier: outsider.publicKey,
        })
        .signers([outsider])
        .rpc();
      expect.fail("expected UnauthorizedVerifier error");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).to.include("UnauthorizedVerifier");
    }
  });

  it("double execute", async () => {
    const seed = 5n;
    const amount = 110_000_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const [escrowPda] = findEscrowPda(seed, maker.publicKey, program.programId);
    const vault = findVaultAddress(escrowPda, mint);

    await program.methods
      .make(new BN(seed.toString()), new BN(amount.toString()), new BN(deadline.toString()))
      .accountsPartial({
        maker: maker.publicKey,
        receiver: receiver.publicKey,
        verifier: verifier.publicKey,
        mint,
      })
      .rpc();

    await program.methods
      .confirmDelivery()
      .accountsPartial({
        escrow: escrowPda,
        verifier: verifier.publicKey,
      })
      .signers([verifier])
      .rpc();

    await program.methods
      .checkAndExecute()
      .accountsStrict({
        caller: outsider.publicKey,
        escrow: escrowPda,
        maker: maker.publicKey,
        receiver: receiver.publicKey,
        mint,
        makerTokenAccount,
        receiverTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        vault,
      })
      .signers([outsider])
      .rpc();

    try {
      await program.methods
        .checkAndExecute()
        .accountsStrict({
          caller: outsider.publicKey,
          escrow: escrowPda,
          maker: maker.publicKey,
          receiver: receiver.publicKey,
          mint,
          makerTokenAccount,
          receiverTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          vault,
        })
        .signers([outsider])
        .rpc();
      expect.fail("expected AlreadyExecuted error");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).to.include("AlreadyExecuted");
    }
  });
});
