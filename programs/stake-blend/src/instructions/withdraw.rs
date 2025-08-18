#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface;
use anchor_spl::stake::Stake;
use anchor_spl::token_interface::spl_token_metadata_interface::borsh::BorshDeserialize;
use spl_stake_pool::state::StakePool;
use crate::instructions::dependencies;
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
    pub user_vault_token_account: InterfaceAccount<'info, token_interface::TokenAccount>,
    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    /// CHECK: Stake pool program
    pub stake_pool_program: Program<'info, dependencies::StakePool>,
    pub clock: Sysvar<'info, Clock>,
    /// CHECK: Stake history sysvar  
    pub stake_history: UncheckedAccount<'info>,
    pub stake_program: Program<'info, Stake>,
    // Remaining accounts: [stake_pool_0, withdraw_authority_0, reserve_stake_0, pool_mint_0, vault_pool_token_account_0, manager_fee_0, ...]
}

pub fn handler<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Withdraw<'info>>, 
    shares: u64
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let vault_bump = ctx.bumps.vault;
    let vault_signer_seeds: &[&[&[u8]]] = &[&[b"vault", &[vault_bump]]];

    let total_pools = vault.stake_pools.len();
    // Validate remaining accounts (6 accounts per pool - no referrer fee for withdrawals)
    require!(
        ctx.remaining_accounts.len() == total_pools * 6,
        ErrorCode::AccountNotEnoughKeys
    );
    require!(
        total_pools >= 1,
        ErrorCode::AccountNotEnoughKeys
    );

    // Step 1: Calculate total vault value and withdrawal proportion
    let mut total_vault_value = 0u64;
    let mut pool_values = Vec::with_capacity(total_pools);
    
    for i in 0..total_pools {
        let base_idx = i * 6;
        let stake_pool_account_info = &ctx.remaining_accounts[base_idx];
        let vault_pool_token_account = &ctx.remaining_accounts[base_idx + 4];

        // Get current pool token balance
        let vault_pool_balance = {
            let account_data = vault_pool_token_account.try_borrow_data()?;
            let token_account = anchor_spl::token::TokenAccount::try_deserialize(&mut account_data.as_ref())?;
            token_account.amount
        };

        if vault_pool_balance > 0 {
            // Deserialize the stake pool to get current value
            let stake_pool_data = stake_pool_account_info.try_borrow_data()?;
            let stake_pool = StakePool::deserialize(&mut stake_pool_data.as_ref())
                .map_err(|_| ErrorCode::AccountDidNotDeserialize)?;

            // Calculate SOL value of our pool tokens
            let pool_sol_value = stake_pool.calc_lamports_withdraw_amount(vault_pool_balance)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
            
            pool_values.push(pool_sol_value);
            total_vault_value = total_vault_value.checked_add(pool_sol_value)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
        } else {
            pool_values.push(0);
        }
    }

    // Step 2: Calculate total withdrawal value
    let withdrawal_proportion = (shares as u128).checked_mul(1_000_000u128)
        .ok_or(ErrorCode::InvalidNumericConversion)?
        .checked_div(vault.total_shares_issued as u128)
        .ok_or(ErrorCode::InvalidNumericConversion)?;
    
    let total_withdrawal_value = (total_vault_value as u128)
        .checked_mul(withdrawal_proportion)
        .ok_or(ErrorCode::InvalidNumericConversion)?
        .checked_div(1_000_000u128)
        .ok_or(ErrorCode::InvalidNumericConversion)? as u64;

    // Burn vault shares from user first
    let burn_accounts = token_interface::Burn {
        mint: ctx.accounts.mint.to_account_info(),
        from: ctx.accounts.user_vault_token_account.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let burn_context = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        burn_accounts
    );
    token_interface::burn(burn_context, shares)?;

    // Step 3: Withdraw proportionally from each pool based on VALUE
    for i in 0..total_pools {
        if pool_values[i] == 0 {
            continue; // Skip empty pools
        }

        let base_idx = i * 6;
        let stake_pool_account_info = &ctx.remaining_accounts[base_idx];
        let withdraw_authority = &ctx.remaining_accounts[base_idx + 1];
        let reserve_stake = &ctx.remaining_accounts[base_idx + 2];
        let pool_mint = &ctx.remaining_accounts[base_idx + 3];
        let vault_pool_token_account = &ctx.remaining_accounts[base_idx + 4];
        let manager_fee = &ctx.remaining_accounts[base_idx + 5];

        // Calculate how much SOL value to withdraw from this pool
        let pool_withdrawal_value = (total_withdrawal_value as u128)
            .checked_mul(pool_values[i] as u128)
            .ok_or(ErrorCode::InvalidNumericConversion)?
            .checked_div(10000u128)
            .ok_or(ErrorCode::InvalidNumericConversion)? as u64;

        if pool_withdrawal_value > 0 {
            // Get current pool token balance
            let vault_pool_balance = {
                let account_data = vault_pool_token_account.try_borrow_data()?;
                let token_account = anchor_spl::token::TokenAccount::try_deserialize(&mut account_data.as_ref())?;
                token_account.amount
            };

            // Calculate pool tokens to withdraw for this SOL value
            let pool_tokens_to_withdraw = (vault_pool_balance as u128)
                .checked_mul(pool_withdrawal_value as u128)
                .ok_or(ErrorCode::InvalidNumericConversion)?
                .checked_div(pool_values[i] as u128)
                .ok_or(ErrorCode::InvalidNumericConversion)? as u64;

            // Ensure we don't try to withdraw more than we have
            let pool_tokens_to_withdraw = pool_tokens_to_withdraw.min(vault_pool_balance);

            if pool_tokens_to_withdraw > 0 {
                let withdraw_instruction = spl_stake_pool::instruction::withdraw_sol(
                    &ctx.accounts.stake_pool_program.key(),
                    &stake_pool_account_info.key(),
                    &withdraw_authority.key(),
                    &vault.key(),
                    &vault_pool_token_account.key(),
                    &reserve_stake.key(),
                    &ctx.accounts.signer.key(),
                    &manager_fee.key(),
                    &pool_mint.key(),
                    &ctx.accounts.token_program.key(),
                    pool_tokens_to_withdraw,
                );

                anchor_lang::solana_program::program::invoke_signed(
                    &withdraw_instruction,
                    &[
                        stake_pool_account_info.to_account_info(),
                        withdraw_authority.to_account_info(),
                        vault.to_account_info(),
                        vault_pool_token_account.to_account_info(),
                        reserve_stake.to_account_info(),
                        ctx.accounts.signer.to_account_info(),
                        manager_fee.to_account_info(),
                        pool_mint.to_account_info(),
                        ctx.accounts.clock.to_account_info(),
                        ctx.accounts.stake_history.to_account_info(),
                        ctx.accounts.stake_program.to_account_info(),
                        ctx.accounts.token_program.to_account_info(),
                    ],
                    vault_signer_seeds,
                )?;
            }
        }
    }

    vault.total_shares_issued -= shares;

    Ok(())
}