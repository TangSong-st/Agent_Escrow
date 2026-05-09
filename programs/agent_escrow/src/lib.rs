use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

declare_id!("EGdjBD33dZjnUGZyFVAwj2qgjQGr59Z4U6vFRQNqzjsD");

const ESCROW_SEED_PREFIX: &[u8] = b"escrow";

#[program]
pub mod agent_escrow {
    use super::*;

    pub fn make(ctx: Context<Make>, seed: u64, amount: u64, deadline: i64) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        require!(deadline > now, EscrowError::InvalidDeadline);

        let escrow = &mut ctx.accounts.escrow;
        escrow.maker = ctx.accounts.maker.key();
        escrow.receiver = ctx.accounts.receiver.key();
        escrow.verifier = ctx.accounts.verifier.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.deadline = deadline;
        escrow.confirmed = false;
        escrow.executed = false;
        escrow.seed = seed;
        escrow.bump = ctx.bumps.escrow;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.maker_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    pub fn confirm_delivery(ctx: Context<ConfirmDelivery>) -> Result<()> {
        require!(
            !ctx.accounts.escrow.executed,
            EscrowError::AlreadyExecuted
        );
        require_keys_eq!(
            ctx.accounts.verifier.key(),
            ctx.accounts.escrow.verifier,
            EscrowError::UnauthorizedVerifier
        );

        ctx.accounts.escrow.confirmed = true;
        Ok(())
    }

    pub fn check_and_execute(ctx: Context<CheckAndExecute>) -> Result<()> {
        require!(
            !ctx.accounts.escrow.executed,
            EscrowError::AlreadyExecuted
        );

        let now = Clock::get()?.unix_timestamp;
        let destination = if ctx.accounts.escrow.confirmed {
            ctx.accounts.receiver_token_account.to_account_info()
        } else if now > ctx.accounts.escrow.deadline {
            ctx.accounts.maker_token_account.to_account_info()
        } else {
            return err!(EscrowError::NotReady);
        };

        let maker_key = ctx.accounts.escrow.maker;
        let seed_bytes = ctx.accounts.escrow.seed.to_le_bytes();
        let bump = [ctx.accounts.escrow.bump];
        let escrow_signer_seeds: &[&[u8]] = &[
            ESCROW_SEED_PREFIX,
            maker_key.as_ref(),
            seed_bytes.as_ref(),
            bump.as_ref(),
        ];
        let signer_seeds = &[escrow_signer_seeds];

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: destination,
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            ctx.accounts.escrow.amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.escrow.executed = true;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.maker.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        ))
    }
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Make<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    /// CHECK: Receiver is stored as a deterministic settlement recipient and validated through its token account during execution.
    pub receiver: UncheckedAccount<'info>,
    /// CHECK: Verifier is stored as the only authority allowed to confirm delivery.
    pub verifier: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = maker,
        associated_token::token_program = token_program
    )]
    pub maker_token_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = maker,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED_PREFIX, maker.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = maker,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ConfirmDelivery<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED_PREFIX, escrow.maker.as_ref(), &escrow.seed.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    pub verifier: Signer<'info>,
}

#[derive(Accounts)]
pub struct CheckAndExecute<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED_PREFIX, escrow.maker.as_ref(), &escrow.seed.to_le_bytes()],
        bump = escrow.bump,
        has_one = mint
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: Maker receives closed vault rent and is validated against escrow.maker.
    #[account(mut, address = escrow.maker)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: Receiver is validated against escrow.receiver.
    #[account(address = escrow.receiver)]
    pub receiver: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = maker,
        associated_token::token_program = token_program
    )]
    pub maker_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = receiver,
        associated_token::token_program = token_program
    )]
    pub receiver_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    #[account(
        mut,
        constraint = escrow.executed || vault.key() == associated_token_address(
            &escrow.key(),
            &mint.key(),
            &token_program.key(),
            &associated_token_program.key()
        ) @ EscrowError::InvalidVault,
        constraint = escrow.executed || token_account_matches(
            &vault.to_account_info(),
            &mint.key(),
            &escrow.key(),
            &token_program.key()
        ) @ EscrowError::InvalidVault
    )]
    /// CHECK: Vault may already be closed on a repeated execute; the handler returns AlreadyExecuted before token CPI.
    pub vault: UncheckedAccount<'info>,
}

#[account]
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

impl Escrow {
    pub const INIT_SPACE: usize = 32 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 8 + 1;
}

#[error_code]
pub enum EscrowError {
    #[msg("Escrow amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Deadline must be in the future.")]
    InvalidDeadline,
    #[msg("Escrow is not confirmed and deadline has not passed.")]
    NotReady,
    #[msg("Only the configured verifier can confirm delivery.")]
    UnauthorizedVerifier,
    #[msg("Escrow has already been executed.")]
    AlreadyExecuted,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Vault token account does not match the escrow PDA and mint.")]
    InvalidVault,
}

fn associated_token_address(
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
    associated_token_program: &Pubkey,
) -> Pubkey {
    let (address, _) = Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        associated_token_program,
    );
    address
}

fn token_account_matches(
    account_info: &AccountInfo,
    mint: &Pubkey,
    authority: &Pubkey,
    token_program: &Pubkey,
) -> bool {
    if account_info.owner != token_program {
        return false;
    }

    let data = match account_info.try_borrow_data() {
        Ok(data) => data,
        Err(_) => return false,
    };
    let mut data_slice: &[u8] = &data;

    match TokenAccount::try_deserialize_unchecked(&mut data_slice) {
        Ok(token_account) => token_account.mint == *mint && token_account.owner == *authority,
        Err(_) => false,
    }
}
