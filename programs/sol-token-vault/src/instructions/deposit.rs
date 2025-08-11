#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface;
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
    pub user_vault_token_account: InterfaceAccount<'info, token_interface::TokenAccount>,
    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    /// CHECK: Stake pool program
    pub stake_pool_program: UncheckedAccount<'info>,
    // Remaining accounts: [stake_pool_0, withdraw_authority_0, reserve_stake_0, pool_mint_0, vault_pool_token_account_0, manager_fee_0, referrer_fee_0, ...]
}

pub fn handler<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Deposit<'info>>, 
    amount: u64
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let mint_bump = ctx.bumps.mint;
    let signer_seeds: &[&[&[u8]]] = &[&[b"mint", &[mint_bump]]];

    let total_pools = vault.stake_pools.len();
    // Validate remaining accounts (7 accounts per pool)
    require!(
        ctx.remaining_accounts.len() == total_pools * 7,
        ErrorCode::AccountNotEnoughKeys
    );
    require!(
        total_pools >= 1,
        ErrorCode::AccountNotEnoughKeys
    );

    // Process ALL pools from remaining accounts
    for i in 0..total_pools {
        let pool_amount = (amount as u128 * vault.allocations[i] as u128 / 10000) as u64;
        
        if pool_amount > 0 {
            let base_idx = i * 7;
            let stake_pool = &ctx.remaining_accounts[base_idx];
            let withdraw_authority = &ctx.remaining_accounts[base_idx + 1];
            let reserve_stake = &ctx.remaining_accounts[base_idx + 2];
            let pool_mint = &ctx.remaining_accounts[base_idx + 3];
            let vault_pool_token_account = &ctx.remaining_accounts[base_idx + 4];
            let manager_fee = &ctx.remaining_accounts[base_idx + 5];
            let referrer_fee = &ctx.remaining_accounts[base_idx + 6];

            let deposit_instruction = spl_stake_pool::instruction::deposit_sol(
                &ctx.accounts.stake_pool_program.key(),
                &stake_pool.key(),
                &withdraw_authority.key(),
                &reserve_stake.key(),
                &ctx.accounts.signer.key(),
                &vault_pool_token_account.key(),
                &manager_fee.key(),
                &referrer_fee.key(),
                &pool_mint.key(),
                &ctx.accounts.token_program.key(),
                pool_amount,
            );

            anchor_lang::solana_program::program::invoke(
                &deposit_instruction,
                &[
                    stake_pool.to_account_info(),
                    withdraw_authority.to_account_info(),
                    reserve_stake.to_account_info(),
                    ctx.accounts.signer.to_account_info(),
                    vault_pool_token_account.to_account_info(),
                    manager_fee.to_account_info(),
                    referrer_fee.to_account_info(),
                    pool_mint.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    ctx.accounts.stake_pool_program.to_account_info(),
                ],
            )?;
        }
    }

    // For now, mint 1:1 vault shares
    let shares_to_mint = amount;
    
    // Mint shares to user
    let cpi_accounts = token_interface::MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.user_vault_token_account.to_account_info(),
        authority: ctx.accounts.mint.to_account_info(),
    };
    let cpi_context = CpiContext::new(
        ctx.accounts.token_program.to_account_info(), 
        cpi_accounts
    ).with_signer(signer_seeds);
    token_interface::mint_to(cpi_context, shares_to_mint)?;
    
    vault.total_shares_issued += shares_to_mint;

    Ok(())
}