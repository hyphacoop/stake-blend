#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

declare_id!("3uUWcoJawNHKnsann7Vrw9LzVhMxgnNUuDeXYuZikYYT");

#[program]
pub mod sol_token_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.total_shares = 0;
        vault.total_sol = 0;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn create_user_account(ctx: Context<CreateUserAccount>) -> Result<()> {
        let user_account = &mut ctx.accounts.user_account;
        user_account.shares = 0;
        user_account.bump = ctx.bumps.user_account;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let user_account = &mut ctx.accounts.user_account;
        
        // Transfer SOL from user to vault
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        // Calculate shares to issue.
        // If this is the first deposit, issue shares equal to the amount deposited.
        // Otherwise, calculate shares based on the current total shares and total SOL in the vault.
        // If nothing is increasing the SOL in the vault, the else will be equivalent to a 1:1 share issuance.
        let shares_to_issue = if vault.total_shares == 0 {
            amount
        } else {
            (amount as u128 * vault.total_shares as u128 / vault.total_sol as u128) as u64
        };

        // Update vault state
        vault.total_sol += amount;
        vault.total_shares += shares_to_issue;

        // Update user account
        user_account.shares += shares_to_issue;

        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let user_account = &mut ctx.accounts.user_account;

        require!(user_account.shares >= shares, VaultError::InsufficientShares);

        // Calculate SOL to return
        let sol_to_return = (shares as u128 * vault.total_sol as u128 / vault.total_shares as u128) as u64;

        // Transfer SOL from vault to user
        **vault.to_account_info().try_borrow_mut_lamports()? -= sol_to_return;
        **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += sol_to_return;

        // Update vault state
        vault.total_sol -= sol_to_return;
        vault.total_shares -= shares;

        // Update user account
        user_account.shares -= shares;

        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub total_shares: u64,
    pub total_sol: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub shares: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault"],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateUserAccount<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [b"user", user.key().as_ref()],
        bump
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault"],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"user", user.key().as_ref()],
        bump = user_account.bump
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault"],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"user", user.key().as_ref()],
        bump = user_account.bump
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[error_code]
pub enum VaultError {
    #[msg("Insufficient shares")]
    InsufficientShares,
}