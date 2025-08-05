#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

pub mod contexts;
pub use contexts::*;
use anchor_spl::token_interface;

declare_id!("3uUWcoJawNHKnsann7Vrw9LzVhMxgnNUuDeXYuZikYYT");

#[program]
pub mod sol_token_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Vault initialized with mint: {}", ctx.accounts.mint.key());
        Ok(())
    }

    pub fn create_user_account(ctx: Context<CreateUserAccount>) -> Result<()> {
        msg!("Token account created: {}", ctx.accounts.token_account.key());
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let mint = &mut ctx.accounts.mint;
        let vault = &mut ctx.accounts.vault;
        let signer_seeds: &[&[&[u8]]] = &[&[b"mint", &[ctx.bumps.mint]]];
 
        // First transfer SOL from the signer to the mint account
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.signer.to_account_info(),
                to: vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        // Now mint the shares to the user's associated token account
        let cpi_accounts = token_interface::MintTo {
            mint: mint.to_account_info(),
            to: ctx.accounts.associated_token_account.to_account_info(),
            authority: mint.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_context = CpiContext::new(cpi_program, cpi_accounts).with_signer(signer_seeds);
        token_interface::mint_to(cpi_context, amount)?;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        let mint = &mut ctx.accounts.mint;
        let vault = &mut ctx.accounts.vault;
        let signer_seeds: &[&[&[u8]]] = &[&[b"mint", &[ctx.bumps.mint]]];

        // Burn the shares from the user's associated token account
        let burn = token_interface::Burn{
            mint: mint.to_account_info(),
            from: ctx.accounts.associated_token_account.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_context = CpiContext::new(cpi_program, burn).with_signer(signer_seeds);
        token_interface::burn(cpi_context, shares)?;

        // Now transfer SOL from vault to user
        **vault.to_account_info().try_borrow_mut_lamports()? -= shares;
        **ctx.accounts.signer.to_account_info().try_borrow_mut_lamports()? += shares;

        Ok(())
    }
}