#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface;
use crate::state::*;
use crate::StakeBlendError;
use anchor_spl::token_interface::spl_token_metadata_interface::borsh::BorshDeserialize;
use spl_stake_pool::state::StakePool;
use crate::instructions::dependencies;

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
    pub stake_pool_program: Program<'info, dependencies::StakePool>,
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

    // Validate that the provided accounts match the vault configuration
    for i in 0..total_pools {
        let base_idx = i * 7;
        let stake_pool_account = &ctx.remaining_accounts[base_idx];
        let withdraw_authority_account = &ctx.remaining_accounts[base_idx + 1];
        let reserve_stake_account = &ctx.remaining_accounts[base_idx + 2];
        let pool_mint_account = &ctx.remaining_accounts[base_idx + 3];
        let manager_fee_account = &ctx.remaining_accounts[base_idx + 5];

        // Validate stake pool matches vault configuration
        require!(
            stake_pool_account.key() == vault.stake_pools[i],
            StakeBlendError::InvalidAccountData
        );

        // Validate pool mint matches vault configuration
        require!(
            pool_mint_account.key() == vault.pool_mints[i],
            StakeBlendError::InvalidAccountData
        );

        // Deserialize the stake pool to validate other accounts
        let stake_pool_data = stake_pool_account.try_borrow_data()?;
        let stake_pool = StakePool::deserialize(&mut stake_pool_data.as_ref())
            .map_err(|_| ErrorCode::AccountDidNotDeserialize)?;

        // Validate withdraw authority matches stake pool's expected withdraw authority
        let (expected_withdraw_authority, _) = spl_stake_pool::find_withdraw_authority_program_address(
            &ctx.accounts.stake_pool_program.key(),
            &stake_pool_account.key(),
        );
        require!(
            withdraw_authority_account.key() == expected_withdraw_authority,
            StakeBlendError::InvalidAccountData
        );

        // Validate reserve stake matches stake pool configuration
        require!(
            reserve_stake_account.key() == stake_pool.reserve_stake,
            StakeBlendError::InvalidAccountData
        );

        // Validate manager fee account matches stake pool configuration
        require!(
            manager_fee_account.key() == stake_pool.manager_fee_account,
            StakeBlendError::InvalidAccountData
        );
    }

    // Step 1: Calculate current vault value before deposit
    let mut total_vault_value = 0u64;
    for i in 0..total_pools {
            let base_idx = i * 7;
            let stake_pool = &ctx.remaining_accounts[base_idx];
        let vault_pool_token_account = &ctx.remaining_accounts[base_idx + 4];

        // Get current pool token balance
        let vault_pool_balance = {
            let account_data = vault_pool_token_account.try_borrow_data()?;
            let token_account = anchor_spl::token::TokenAccount::try_deserialize(&mut account_data.as_ref())?;
            token_account.amount
    };

        if vault_pool_balance > 0 {
            // Deserialize the stake pool to get current value
            let stake_pool_data = stake_pool.try_borrow_data()?;
            let stake_pool = StakePool::deserialize(&mut stake_pool_data.as_ref())
                .map_err(|_| ErrorCode::AccountDidNotDeserialize)?;

            // Calculate SOL value of our pool tokens
            let pool_sol_value = stake_pool.calc_lamports_withdraw_amount(vault_pool_balance)
                .ok_or(ErrorCode::InvalidNumericConversion)?;

            total_vault_value = total_vault_value.checked_add(pool_sol_value)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
        }
    }

    // Step 2: Calculate shares to mint based on current share price
    let shares_to_mint = if vault.total_shares_issued == 0 {
        // First deposit: mint 1:1
        amount
    } else {
        // Calculate current share price: total_vault_value / total_shares_issued
        // Then: shares_to_mint = amount / share_price = amount * total_shares_issued / total_vault_value
        (amount as u128)
            .checked_mul(vault.total_shares_issued as u128)
            .ok_or(ErrorCode::InvalidNumericConversion)?
            .checked_div(total_vault_value as u128)
            .ok_or(ErrorCode::InvalidNumericConversion)? as u64
    };

    // Step 3: Process deposits to ALL pools
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

    // Step 4: Mint proportional shares to user
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
