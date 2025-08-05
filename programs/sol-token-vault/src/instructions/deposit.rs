#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use anchor_spl::associated_token::AssociatedToken;
use crate::state::*;

#[derive(Accounts)]
pub struct Deposit<'info> {
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

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
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