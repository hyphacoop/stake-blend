#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface::{
    Mint, TokenInterface
};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::*;

#[derive(Accounts)]
#[instruction(vault_id: u64, allocations: Vec<u16>)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = signer,
        mint::decimals = 9,
        mint::authority = mint.key(),
        mint::freeze_authority = mint.key(),
        seeds = [b"mint", vault_id.to_le_bytes().as_ref()],
        bump
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = signer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", vault_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    // Remaining accounts: [stake_pool_0, pool_mint_0, ata_0, stake_pool_1, pool_mint_1, ata_1, ...]
}

pub fn handler<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Initialize<'info>>, vault_id: u64, allocations: Vec<u16>
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    
    // Calculate total number of pools
    let total_pools = ctx.remaining_accounts.len() / 3;
    
    // Validate we have the right number of accounts and allocations
    require!(
        ctx.remaining_accounts.len() % 3 == 0,
        ErrorCode::AccountNotEnoughKeys
    );
    require!(
        allocations.len() == total_pools,
        ErrorCode::AccountNotEnoughKeys
    );
    require!(
        total_pools >= 1,
        ErrorCode::AccountNotEnoughKeys
    );
    // Validate allocations sum to 100%
    let total_allocation: u32 = allocations.iter().map(|&x| x as u32).sum();
    require!(
        total_allocation == 10000,
        ErrorCode::InvalidNumericConversion
    );
    
    // Build vectors from ALL remaining accounts
    let mut stake_pools = Vec::new();
    let mut pool_mints = Vec::new();
    
    // Parse remaining accounts (triplets: stake_pool, pool_mint, ata, ...)
    for i in (0..ctx.remaining_accounts.len()).step_by(3) {
        let stake_pool = &ctx.remaining_accounts[i];
        let pool_mint = &ctx.remaining_accounts[i + 1];
        let ata_account = &ctx.remaining_accounts[i + 2];

        stake_pools.push(stake_pool.key());
        pool_mints.push(pool_mint.key());

        // Create ATA for this pool
        anchor_spl::associated_token::create(
            CpiContext::new(
                ctx.accounts.associated_token_program.to_account_info(),
                anchor_spl::associated_token::Create {
                    payer: ctx.accounts.signer.to_account_info(),
                    associated_token: ata_account.to_account_info(),
                    authority: vault.to_account_info(),
                    mint: pool_mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ),
        )?;
 
        msg!("Created ATA for pool {}: {}", i/3, ata_account.key());
    }

    // Initialize vault state
    vault.vault_id = vault_id;
    vault.stake_pools = stake_pools;
    vault.pool_mints = pool_mints;
    vault.allocations = allocations;
    vault.total_shares_issued = 0;
    vault.bump = ctx.bumps.vault;

    msg!("Vault {} initialized with {} stake pools", vault_id, total_pools);

    Ok(())
}