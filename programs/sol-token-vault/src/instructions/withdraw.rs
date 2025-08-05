#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use anchor_spl::associated_token::AssociatedToken;
use crate::state::*;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"mint"],
        bump
    )]
    pub mint: InterfaceAccount<'info, token_interface::Mint>,
    #[account(
        mut,
        seeds = [b"vault"],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub associated_token_account: InterfaceAccount<'info, token_interface::TokenAccount>,
    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handler(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
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