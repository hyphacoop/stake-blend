#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenInterface, TokenAccount,
};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = signer,
        mint::decimals = 6,
        mint::authority = mint.key(),
        mint::freeze_authority = mint.key(),
        seeds = [b"mint"],
        bump
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = signer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault"],
        bump
    )]
    pub vault: Account<'info, Vault>,
    
    // Pool mints from each stake pool
    pub pool_mint_0: InterfaceAccount<'info, Mint>,
    
    // ATAs to create for holding pool tokens
    #[account(
        init,
        payer = signer,
        associated_token::mint = pool_mint_0,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_pool_token_account_0: InterfaceAccount<'info, TokenAccount>,
    
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    
    // Hardcoded vetted stake pools
    let stake_pools = [
        Pubkey::from_str_const("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"),
    ];
    
    let pool_mints = [
        ctx.accounts.pool_mint_0.key(),
    ];
    
    // Equal allocation across pools
    let allocations = [10000u16];
    
    vault.stake_pools = stake_pools;
    vault.pool_mints = pool_mints;
    vault.allocations = allocations;
    vault.total_shares_issued = 0;
    vault.bump = ctx.bumps.vault;
    
    msg!("Vault initialized with {} stake pools", stake_pools.len());
    msg!("Pool token accounts: {}", 
         ctx.accounts.vault_pool_token_account_0.key(),
    );
    Ok(())
}