# Agent Escrow Code Walkthrough

## 1. Project Purpose

`agent-escrow` is a rule-based escrow settlement project on Solana.

The key idea is:

- funds are locked into an SPL token vault
- the vault is controlled by a program-derived address (PDA)
- anyone can call the execute instruction
- but no caller can arbitrarily redirect funds
- final settlement is determined only by on-chain rules

Decision rules:

1. if `confirmed == true`, release funds to `receiver`
2. else if current time is past `deadline`, refund funds to `maker`
3. else fail with `NotReady`

This means execution is permissionless, but settlement is deterministic.

---

## 2. Repository Structure

```text
agent-escrow/
├── programs/agent_escrow/src/lib.rs
├── tests/agent-escrow.ts
├── scripts/
│   ├── buyer-agent.ts
│   ├── verifier-agent.ts
│   └── keeper-agent.ts
├── app/
│   └── src/
│       ├── App.tsx
│       ├── lib/
│       ├── components/
│       └── idl/
├── Anchor.toml
├── package.json
├── tsconfig.json
└── README.md
```

Responsibilities:

- `programs/agent_escrow/src/lib.rs`: on-chain rules and state
- `tests/agent-escrow.ts`: integration tests for all settlement paths
- `scripts/*.ts`: command-line automation agents
- `app/src/*`: frontend UI and wallet flow

---

## 3. High-Level Architecture

```text
Maker / Buyer / User
        |
        | make()
        v
Escrow PDA account --------------------+
        |                              |
        | controls                     |
        v                              |
Vault ATA (SPL Token Account)          |
        |                              |
        | check_and_execute()          |
        v                              |
Receiver ATA or Maker ATA <------------+
```

What lives where:

- escrow metadata lives in the `Escrow` account
- tokens live in the `vault` token account
- the vault owner is the escrow PDA
- the maker and receiver user wallets do not directly control vault funds once escrow is created

---

## 4. On-Chain Data Model

Source file:

- [programs/agent_escrow/src/lib.rs](/home/don/codexAgentEscrow/programs/agent_escrow/src/lib.rs)

### 4.1 Escrow Account

The on-chain account is:

```rust
pub struct Escrow {
    pub maker: Pubkey,
    pub receiver: Pubkey,
    pub verifier: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub confirmed: bool,
    pub executed: bool,
    pub seed: u64,
    pub bump: u8,
}
```

### 4.2 Field-by-Field Meaning

#### `maker: Pubkey`

- the wallet that creates the escrow
- the wallet that originally owns the tokens
- the wallet that pays rent for creating the escrow and vault
- the wallet that receives the refund if the deadline expires without confirmation
- the wallet that receives the vault rent back when the vault is closed

#### `receiver: Pubkey`

- the intended payout recipient
- if `confirmed == true`, tokens are sent here
- this field is stored inside the escrow account and cannot be changed later

#### `verifier: Pubkey`

- the only wallet allowed to call `confirm_delivery`
- this is not the maker unless the creator intentionally sets it that way
- the verifier does not receive funds
- the verifier only flips the settlement condition from unconfirmed to confirmed

#### `mint: Pubkey`

- the SPL token mint used for this escrow
- all token movements for the escrow must use this mint
- the vault account must belong to this mint
- maker and receiver token accounts must also correspond to this mint

#### `amount: u64`

- the token amount stored in raw base units on chain
- this is very important:
  - if mint decimals = `6`
  - user-facing `1.0 token`
  - on-chain `amount = 1000000`
- the chain program always stores raw units, not decimal strings

#### `deadline: i64`

- unix timestamp in seconds
- if current on-chain time becomes greater than this value and `confirmed == false`
  then the refund path becomes valid

#### `confirmed: bool`

- starts as `false`
- can only be changed to `true` by the configured verifier
- once `true`, the release path becomes valid

#### `executed: bool`

- starts as `false`
- becomes `true` after either:
  - release to receiver
  - refund to maker
- prevents double execution

#### `seed: u64`

- user-provided unique number
- used as part of the PDA derivation
- allows the same maker to create multiple escrows

#### `bump: u8`

- PDA bump for the escrow account
- stored so the program can later sign CPI calls with the escrow PDA seeds

---

## 5. PDA Design

### 5.1 Escrow PDA

Escrow PDA seeds:

```text
["escrow", maker_pubkey, seed_le_bytes]
```

Purpose:

- creates a deterministic account address for each maker + seed pair
- acts as the authority over the vault token account

### 5.2 Vault Address

The vault is the associated token account for:

- owner = escrow PDA
- mint = escrow.mint

So the vault is not an arbitrary token account.
It is the canonical ATA of the escrow PDA for the selected mint.

Why that matters:

- simpler derivation
- easier verification
- prevents mismatched vault addresses

---

## 6. Where Data Is Stored

### 6.1 On Chain

Stored permanently on Solana until closed or rent reclaimed:

- `Escrow` account:
  - maker
  - receiver
  - verifier
  - mint
  - amount
  - deadline
  - confirmed
  - executed
  - seed
  - bump
- `vault` SPL token account:
  - token balance
  - mint
  - owner = escrow PDA

### 6.2 In the Frontend Runtime

Stored in React state in [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx):

- currently loaded escrow PDA
- currently loaded escrow state
- current wallet token balance
- current dev mint
- transaction status text
- latest transaction signature

### 6.3 In Browser Local Storage

Stored locally in the browser:

- recent escrow PDAs
- their mint
- last loaded time
- last known status

This is why the user does not have to manually remember every escrow PDA after creating it.

### 6.4 In Tests

Test-created keys and accounts exist in:

- local validator ledger state during test execution
- TypeScript variables inside [tests/agent-escrow.ts](/home/don/codexAgentEscrow/tests/agent-escrow.ts)

### 6.5 In Scripts

Script configuration comes from:

- environment variables
- local wallet keypair configured by Anchor / Solana CLI

---

## 7. On-Chain Instructions

## 7.1 `make(seed, amount, deadline)`

Purpose:

- create escrow metadata
- create vault token account
- move maker tokens into the vault

### Validation

The program checks:

1. `amount > 0`
2. `deadline > current on-chain time`

If not:

- `InvalidAmount`
- `InvalidDeadline`

### Accounts Involved

- `maker`: signer, payer, source token owner
- `receiver`: stored in escrow
- `verifier`: stored in escrow
- `mint`: token mint
- `maker_token_account`: maker ATA for mint
- `escrow`: PDA account to initialize
- `vault`: PDA-owned ATA to initialize
- `token_program`
- `associated_token_program`
- `system_program`
- `rent`

### Step-by-Step Logic

1. read current clock time
2. validate amount and deadline
3. initialize escrow account
4. store all escrow fields
5. initialize vault ATA with:
   - mint = selected mint
   - authority = escrow PDA
6. call `transfer_checked`
7. move `amount` raw units from maker token account to vault

### Why `transfer_checked`

It uses mint decimals and validates token correctness more safely than unchecked transfer.

---

## 7.2 `confirm_delivery()`

Purpose:

- mark the escrow as confirmed by the verifier

### Validation

1. `executed` must still be `false`
2. signer must equal `escrow.verifier`

If not:

- `AlreadyExecuted`
- `UnauthorizedVerifier`

### Step-by-Step Logic

1. load escrow
2. check it has not been executed
3. check signer matches verifier pubkey
4. set `confirmed = true`

No token movement happens here.

---

## 7.3 `check_and_execute()`

Purpose:

- permissionlessly settle the escrow according to rules

Important:

- caller can be anyone
- caller does not decide the destination
- the program alone decides settlement

### Validation

1. escrow must not already be executed
2. if confirmed, release path is chosen
3. else if time > deadline, refund path is chosen
4. else fail with `NotReady`

### Accounts Involved

- `caller`: any signer
- `escrow`: PDA state account
- `maker`: must match `escrow.maker`
- `receiver`: must match `escrow.receiver`
- `mint`: must match `escrow.mint`
- `maker_token_account`: ATA of maker for mint
- `receiver_token_account`: ATA of receiver for mint
- `vault`: PDA ATA for escrow + mint
- `token_program`
- `associated_token_program`

### Step-by-Step Logic

1. load escrow
2. check `executed == false`
3. read current on-chain clock
4. branch:
   - if `confirmed == true`: destination = receiver token account
   - else if `now > deadline`: destination = maker token account
   - else error `NotReady`
5. reconstruct signer seeds from:
   - `"escrow"`
   - `maker`
   - `seed`
   - `bump`
6. call `transfer_checked` with signer seeds
7. move tokens from vault to chosen destination
8. set `executed = true`
9. close vault account
10. return vault rent to maker

### Why the caller cannot steal funds

Because the caller is not used as the token destination.

The destination is selected exclusively from:

- receiver token account
- maker token account

Those accounts are both constrained and derived from escrow state.

---

## 8. Error Types

Defined in `EscrowError`.

### `InvalidAmount`

- amount passed to `make` is `0`

### `InvalidDeadline`

- deadline is not later than current chain time

### `NotReady`

- escrow is not confirmed
- deadline has not passed
- execute must fail

### `UnauthorizedVerifier`

- wrong wallet tried to confirm

### `AlreadyExecuted`

- someone tried to confirm or execute after settlement already happened

### `MathOverflow`

- reserved for arithmetic safety handling

### `InvalidVault`

- provided vault account does not match the expected PDA ATA

---

## 9. Frontend Architecture

Key files:

- [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)
- [app/src/lib/anchor.ts](/home/don/codexAgentEscrow/app/src/lib/anchor.ts)
- [app/src/lib/pda.ts](/home/don/codexAgentEscrow/app/src/lib/pda.ts)
- [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)
- [app/src/components/CreateEscrowForm.tsx](/home/don/codexAgentEscrow/app/src/components/CreateEscrowForm.tsx)
- [app/src/components/EscrowStatus.tsx](/home/don/codexAgentEscrow/app/src/components/EscrowStatus.tsx)

### 9.1 `App.tsx`

This is the frontend coordinator.

It is responsible for:

- wallet connection state
- submitting transactions
- loading escrow state
- formatting balances and deadlines
- storing recent escrows
- showing user-friendly messages

### 9.2 Amount Handling in the Frontend

This is now unified:

- users type amounts in token units
- chain stores amounts in raw units

Example with mint decimals = `6`:

- input `1`
- frontend converts to raw using `parseTokenAmount(...)`
- chain receives `1000000`
- UI displays:
  - `1 tokens`
  - `1000000 raw`

This conversion logic lives in:

- [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)

Functions:

- `parseTokenAmount(amount, decimals)`
- `formatTokenAmount(amount, decimals)`

### 9.3 `submitTransaction(...)`

This helper centralizes wallet transaction flow.

Step-by-step:

1. check wallet is connected
2. fetch latest blockhash
3. set `feePayer`
4. set `recentBlockhash`
5. partial-sign extra keypairs if needed
6. ask wallet to sign
7. send raw transaction
8. wait for confirmation
9. update UI stage text throughout

Why this exists:

- avoids wallet adapter inconsistency
- creates uniform feedback for minting, escrow creation, confirm, and execute

### 9.4 `loadEscrowState(...)`

This function:

1. fetches escrow account
2. fetches mint decimals
3. computes vault address
4. fetches maker ATA balance
5. fetches receiver ATA balance
6. fetches vault balance
7. derives current UI state
8. stores the escrow in recent-history local storage

### 9.5 Frontend Status Meaning

Current UI state values:

#### `NotReady`

- not confirmed
- deadline not passed
- execute should not proceed

#### `Confirmed`

- verifier has confirmed
- release path is ready
- not executed yet

#### `Refundable`

- not confirmed
- deadline passed
- refund path is ready
- not executed yet

#### `Released`

- escrow was executed after confirmation
- receiver got funds

#### `Refunded`

- escrow was executed after timeout
- maker got refund

---

## 10. Frontend Components

## 10.1 `CreateEscrowForm`

Responsibilities:

- collect receiver
- collect verifier
- collect mint
- collect amount in token units
- collect deadline
- collect seed

Validation:

- receiver must be a valid public key
- verifier must be a valid public key
- mint must be a valid public key
- amount must be positive
- seed must not be empty

It does not directly talk to the chain.
It passes sanitized form data back to `App.tsx`.

## 10.2 `EscrowStatus`

Responsibilities:

- allow manual escrow PDA lookup
- show recent escrows from local storage
- display the loaded escrow state

Displays:

- maker
- receiver
- verifier
- mint
- amount in token units
- raw amount
- mint decimals
- deadline
- confirmed
- executed
- vault
- maker balance
- receiver balance
- vault balance
- current state
- execution hint
- escrow PDA

## 10.3 `ConfirmButton`

Responsibilities:

- only makes sense when current wallet equals `verifier`
- becomes disabled or shows hint otherwise

## 10.4 `ExecuteButton`

Responsibilities:

- anyone can click it
- but frontend pre-check prevents pointless signing when chain would return `NotReady`

This is a UX optimization.
The chain remains the real source of truth.

---

## 11. Token Helper Layer

Source:

- [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)

### `getOrCreateAtaInstruction(...)`

Purpose:

- find the ATA for owner + mint
- if missing, return a transaction that creates it
- if already present, return `instruction: null`

### `getTokenBalance(...)`

Purpose:

- safely load a token account
- return `0n` if missing

This is why the UI can still display balances without crashing when an ATA does not exist yet.

### `getMintDecimals(...)`

Purpose:

- read decimals from the mint account

### `formatTokenAmount(...)`

Purpose:

- convert raw `bigint` to human-readable decimal string

### `parseTokenAmount(...)`

Purpose:

- convert human-readable token string to raw units

This function is central to amount consistency.

---

## 12. Script Layer

Files:

- [scripts/buyer-agent.ts](/home/don/codexAgentEscrow/scripts/buyer-agent.ts)
- [scripts/verifier-agent.ts](/home/don/codexAgentEscrow/scripts/verifier-agent.ts)
- [scripts/keeper-agent.ts](/home/don/codexAgentEscrow/scripts/keeper-agent.ts)

### `buyer-agent.ts`

Purpose:

- create an escrow from CLI

Expected inputs:

- receiver
- verifier
- mint
- amount
- deadline

Outputs:

- escrow PDA
- vault
- deadline
- transaction signature

### `verifier-agent.ts`

Purpose:

- confirm delivery for an existing escrow

Expected input:

- escrow PDA

### `keeper-agent.ts`

Purpose:

- permissionlessly call execute on an escrow

Expected input:

- escrow PDA

This script is the practical example of the “agent” concept:

- not AI
- just an automated executor
- runs rules already defined on chain

---

## 13. Test Coverage

Source:

- [tests/agent-escrow.ts](/home/don/codexAgentEscrow/tests/agent-escrow.ts)

Covered paths:

### 13.1 Release Path

Flow:

1. create mint
2. mint maker tokens
3. create escrow
4. verifier confirms
5. third party executes
6. assert receiver balance increased
7. assert `executed == true`

### 13.2 Refund Path

Flow:

1. create escrow with short deadline
2. do not confirm
3. wait until timeout
4. third party executes
5. assert maker receives refund
6. assert receiver did not receive tokens
7. assert `executed == true`

### 13.3 Not Ready

Flow:

1. create escrow
2. do not confirm
3. do not wait for timeout
4. execute should fail with `NotReady`

### 13.4 Unauthorized Verifier

Flow:

1. create escrow
2. wrong wallet calls confirm
3. should fail with `UnauthorizedVerifier`

### 13.5 Double Execute

Flow:

1. successfully execute once
2. execute again
3. should fail with `AlreadyExecuted`

---

## 14. Full Lifecycle Example

Let’s walk through a concrete example.

Assume:

- mint decimals = `6`
- maker wants to escrow `2.5` tokens

### Step 1: User Inputs in Frontend

User enters:

- amount = `2.5`

Frontend converts:

- `2.5` -> `2500000 raw`

### Step 2: `make(...)`

Program stores:

- `amount = 2500000`
- `confirmed = false`
- `executed = false`

And moves:

- `2500000 raw` from maker ATA -> vault ATA

### Step 3A: Confirmed Path

Verifier calls `confirm_delivery()`

Program changes:

- `confirmed = true`

Then any caller can invoke `check_and_execute()`

Program does:

- transfer from vault -> receiver ATA
- set `executed = true`
- close vault

Final state:

- `confirmed = true`
- `executed = true`
- UI state = `Released`

### Step 3B: Timeout Refund Path

If no confirmation happens and deadline passes:

- anyone calls `check_and_execute()`
- program transfers from vault -> maker ATA
- set `executed = true`
- close vault

Final state:

- `confirmed = false`
- `executed = true`
- UI state = `Refunded`

### Step 3C: Not Ready Path

If no confirmation and deadline not passed:

- execute is attempted
- program rejects with `NotReady`
- no balances change
- `executed` stays `false`

Frontend now also pre-checks this case to avoid pointless signing.

---

## 15. Why This Design Is Safe

### Funds are never controlled by the caller

The caller only triggers the function.
They do not choose the destination.

### The destination is determined from escrow state

It can only be:

- receiver ATA
- maker ATA

### Vault authority is a PDA

No user private key directly owns the vault.

### Execution is idempotent after first success

After `executed = true`, repeated execution fails.

### Token mint consistency is enforced

The mint and associated token accounts are constrained in the program.

---

## 16. Common Sources of Confusion

### “Why does amount look different on chain and in UI?”

Because:

- chain stores raw units
- UI shows token units

Example:

- `1 token` with `6 decimals`
- raw = `1000000`

### “Why can anyone execute?”

Because execute is only a trigger.
It is not an authorization to route funds arbitrarily.

### “Why does the vault disappear after execution?”

Because it is closed after settlement and its rent is returned to the maker.

### “Why do I need a receiver ATA?”

Because SPL tokens must land in a valid token account for the correct mint.

### “Why is `confirmed = true` but `executed = false`?”

That means:

- verifier approved release
- but nobody has called execute yet

---

## 17. Suggested Reading Order

If you want to understand the code efficiently, read in this order:

1. [programs/agent_escrow/src/lib.rs](/home/don/codexAgentEscrow/programs/agent_escrow/src/lib.rs)
2. [tests/agent-escrow.ts](/home/don/codexAgentEscrow/tests/agent-escrow.ts)
3. [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)
4. [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)
5. [app/src/components/EscrowStatus.tsx](/home/don/codexAgentEscrow/app/src/components/EscrowStatus.tsx)
6. [scripts/keeper-agent.ts](/home/don/codexAgentEscrow/scripts/keeper-agent.ts)

This order makes the project much easier to parse:

- rules first
- tests second
- UI and tooling after

---

## 18. Final Summary

This project has a very clean separation of concerns:

- the program decides settlement
- the vault holds funds
- the verifier can confirm
- anyone can execute
- the frontend helps users interact safely
- scripts automate the exact same flows from CLI

The most important mental model is:

1. user-facing amounts are token units
2. on-chain amounts are raw units
3. vault ownership belongs to the escrow PDA
4. execution is open
5. settlement outcome is not open

That is the heart of `agent-escrow`.
