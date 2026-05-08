# agent-escrow

Rule-based escrow on Solana for automated agents, keepers, verifiers, and settlement bots.

This project treats "Agent" as an automation actor, not an AI model.

- Funds are locked in an SPL token vault controlled by a PDA
- Execution is permissionless
- Decision is deterministic
- `confirmed = true` releases to the receiver
- `deadline` passed without confirmation refunds the maker
- Before either condition is true, execution fails with `NotReady`

## Architecture

```text
Buyer Agent / User
        |
        v
Escrow Program
        |
        v
Vault PDA
        |
        v
Receiver / Refund
```

## Project Layout

```text
agent-escrow/
├── programs/agent_escrow/src/lib.rs
├── tests/agent-escrow.ts
├── scripts/buyer-agent.ts
├── scripts/verifier-agent.ts
├── scripts/keeper-agent.ts
├── app/
├── Anchor.toml
├── package.json
├── tsconfig.json
└── README.md
```

## Install And Run

```bash
npm install
anchor build
anchor test
cd app
npm install
npm run dev
```

## Localnet Flow

1. Start a validator:

```bash
solana-test-validator
```

2. In another terminal, deploy:

```bash
anchor build
anchor deploy
```

3. Run tests:

```bash
anchor test
```

4. Start the frontend:

```bash
cd app
npm install
npm run dev
```

5. In the UI, create a dev mint, mint tokens to your wallet, create escrow, confirm, then execute.

## Devnet Flow

1. Deploy:

```bash
anchor deploy --provider.cluster devnet
```

2. Update the program id in:

- `programs/agent_escrow/src/lib.rs`
- `Anchor.toml`
- `app/src/idl/agent_escrow.json`

3. Rebuild and copy the fresh IDL to the app:

```bash
anchor build
cp target/idl/agent_escrow.json app/src/idl/agent_escrow.json
```

4. Use a devnet SPL mint and funded wallet.

## Script Usage

Environment variables:

```bash
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=~/.config/solana/id.json
```

Buyer agent:

```bash
RECEIVER=<receiver_pubkey> \
VERIFIER=<verifier_pubkey> \
MINT=<mint_pubkey> \
AMOUNT=1000000 \
DEADLINE=1735689600 \
npm run buyer-agent
```

Verifier agent:

```bash
ESCROW=<escrow_pda> npm run verifier-agent
```

Keeper agent:

```bash
ESCROW=<escrow_pda> npm run keeper-agent
```

## Frontend

The app supports Phantom and Solflare through Wallet Adapter. It shows:

- connected wallet address
- current network as `localnet` or `devnet`
- create escrow form
- escrow status lookup
- verifier-only confirm
- permissionless execute button
- dev token helper for local testing

For localnet, transaction signatures are shown directly. For devnet, Explorer links are shown.

## FAQ

Why can anyone execute?

Because execution is just a trigger. The contract evaluates `confirmed`, `executed`, and `deadline`, then deterministically routes funds.

Can a malicious keeper steal funds?

No. The keeper is not part of settlement logic. The keeper can only trigger the program, and the program decides whether to release, refund, or reject.

What if the buyer never confirms?

Once the deadline passes, any keeper can execute the refund path back to the maker.

Why is this useful for agents?

Automated agents need predictable, scriptable settlement conditions. A deterministic on-chain rule engine works better than off-chain discretion.

Why is this not ideal for informal offline human trade?

Because the contract only sees on-chain facts and timestamps. It does not understand subjective delivery disputes or real-world nuance.
