#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface;
use anchor_spl::stake::Stake;
use anchor_spl::token_interface::spl_token_metadata_interface::borsh::BorshDeserialize;
use spl_stake_pool::state::StakePool;
use crate::instructions::dependencies;
use crate::state::*;
use crate::StakeBlendError;

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"mint", vault_id.to_le_bytes().as_ref()],
        bump
    )]
    pub mint: InterfaceAccount<'info, token_interface::Mint>,
    #[account(
        mut,
        seeds = [b"vault", vault_id.to_le_bytes().as_ref()],
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
    pub clock: Sysvar<'info, Clock>,
    pub stake_history: Sysvar<'info, StakeHistory>,
    pub stake_program: Program<'info, Stake>,
    // Remaining accounts: [stake_pool_0, withdraw_authority_0, reserve_stake_0, pool_mint_0, vault_pool_token_account_0, manager_fee_0, ...]
}

/// Pool account references for withdrawal operations
struct PoolAccounts<'info> {
    stake_pool: &'info AccountInfo<'info>,
    withdraw_authority: &'info AccountInfo<'info>,
    reserve_stake: &'info AccountInfo<'info>,
    pool_mint: &'info AccountInfo<'info>,
    vault_pool_token_account: &'info AccountInfo<'info>,
    manager_fee: &'info AccountInfo<'info>,
}

/// Pool value data for withdrawal calculations
struct PoolValue {
    sol_value: u64,
    token_balance: u64,
}

pub fn handler<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Withdraw<'info>>,
    vault_id: u64,
    shares: u64
) -> Result<()> {
    let vault_bump = ctx.bumps.vault;
    let vault_id_bytes = vault_id.to_le_bytes();
    let vault_signer_seeds: &[&[&[u8]]] = &[&[b"vault", vault_id_bytes.as_ref(), &[vault_bump]]];
    
    // Validate account structure
    let total_pools = ctx.accounts.vault.stake_pools.len();
    validate_remaining_accounts(&ctx, total_pools)?;
    
    // Validate and calculate pool values
    let pool_values = validate_and_calculate_pool_values(&ctx, &ctx.accounts.vault)?;
    let total_vault_value = pool_values.iter().map(|pv| pv.sol_value).sum::<u64>();
    
    // Calculate withdrawal amounts
    let total_withdrawal_value = calculate_withdrawal_value(shares, ctx.accounts.vault.total_shares_issued, total_vault_value)?;
    
    // Burn user shares first
    burn_user_shares(&ctx, shares)?;
    
    // Execute withdrawals from each pool
    execute_pool_withdrawals(&ctx, &ctx.accounts.vault, &pool_values, total_withdrawal_value, total_vault_value, vault_signer_seeds)?;
    
    // Update vault state
    ctx.accounts.vault.total_shares_issued -= shares;

    Ok(())
}

fn validate_remaining_accounts<'info>(
    ctx: &Context<'_, '_, '_, 'info, Withdraw<'info>>,
    total_pools: usize
) -> Result<()> {
    const ACCOUNTS_PER_POOL: usize = 6; // No referrer fee for withdrawals
    
    require!(
        ctx.remaining_accounts.len() == total_pools * ACCOUNTS_PER_POOL,
        ErrorCode::AccountNotEnoughKeys
    );
    require!(total_pools >= 1, ErrorCode::AccountNotEnoughKeys);
    
    Ok(())
}

fn validate_and_calculate_pool_values<'info>(
    ctx: &Context<'_, '_, 'info, 'info, Withdraw<'info>>,
    vault: &Vault
) -> Result<Vec<PoolValue>> {
    let total_pools = vault.stake_pools.len();
    let mut pool_values = Vec::with_capacity(total_pools);
    
    for i in 0..total_pools {
        let pool_accounts = get_pool_accounts(&ctx.remaining_accounts, i);
        
        // Validate account keys match vault configuration
        validate_pool_account_keys(&pool_accounts, vault, i)?;
        
        // Deserialize stake pool and validate derived accounts
        let stake_pool = deserialize_stake_pool(pool_accounts.stake_pool)?;
        validate_derived_accounts(&pool_accounts, &stake_pool, &ctx.accounts.stake_pool_program.key())?;
        
        // Calculate pool value
        let token_balance = get_token_account_balance(pool_accounts.vault_pool_token_account)?;
        let sol_value = if token_balance > 0 {
            stake_pool.calc_lamports_withdraw_amount(token_balance)
                .ok_or(ErrorCode::InvalidNumericConversion)?
        } else {
            0
        };
        
        pool_values.push(PoolValue { sol_value, token_balance });
    }
    
    Ok(pool_values)
}

fn get_pool_accounts<'info>(remaining_accounts: &'info [AccountInfo<'info>], pool_index: usize) -> PoolAccounts<'info> {
    let base_idx = pool_index * 6;
    PoolAccounts {
        stake_pool: &remaining_accounts[base_idx],
        withdraw_authority: &remaining_accounts[base_idx + 1],
        reserve_stake: &remaining_accounts[base_idx + 2],
        pool_mint: &remaining_accounts[base_idx + 3],
        vault_pool_token_account: &remaining_accounts[base_idx + 4],
        manager_fee: &remaining_accounts[base_idx + 5],
    }
}

fn validate_pool_account_keys(
    pool_accounts: &PoolAccounts,
    vault: &Vault,
    pool_index: usize
) -> Result<()> {
    require!(
        pool_accounts.stake_pool.key() == vault.stake_pools[pool_index],
        StakeBlendError::InvalidAccountData
    );
    require!(
        pool_accounts.pool_mint.key() == vault.pool_mints[pool_index],
        StakeBlendError::InvalidAccountData
    );
    Ok(())
}

fn deserialize_stake_pool(stake_pool_account: &AccountInfo) -> Result<StakePool> {
    let stake_pool_data = stake_pool_account.try_borrow_data()?;
    StakePool::deserialize(&mut stake_pool_data.as_ref())
        .map_err(|_| ErrorCode::AccountDidNotDeserialize.into())
}

fn validate_derived_accounts(
    pool_accounts: &PoolAccounts,
    stake_pool: &StakePool,
    stake_pool_program_key: &Pubkey
) -> Result<()> {
    // Validate withdraw authority
    let (expected_withdraw_authority, _) = spl_stake_pool::find_withdraw_authority_program_address(
        stake_pool_program_key,
        &pool_accounts.stake_pool.key(),
    );
    require!(
        pool_accounts.withdraw_authority.key() == expected_withdraw_authority,
        StakeBlendError::InvalidAccountData
    );
    
    // Validate reserve stake
    require!(
        pool_accounts.reserve_stake.key() == stake_pool.reserve_stake,
        StakeBlendError::InvalidAccountData
    );
    
    // Validate manager fee account
    require!(
        pool_accounts.manager_fee.key() == stake_pool.manager_fee_account,
        StakeBlendError::InvalidAccountData
    );
    
    Ok(())
}

fn get_token_account_balance(token_account: &AccountInfo) -> Result<u64> {
    let account_data = token_account.try_borrow_data()?;
    let token_account = anchor_spl::token::TokenAccount::try_deserialize(&mut account_data.as_ref())?;
    Ok(token_account.amount)
}

fn calculate_withdrawal_value(
    shares: u64,
    total_shares_issued: u64,
    total_vault_value: u64
) -> Result<u64> {
    const PRECISION: u128 = 1_000_000u128;
    
    let withdrawal_proportion = (shares as u128)
        .checked_mul(PRECISION)
        .ok_or(ErrorCode::InvalidNumericConversion)?
        .checked_div(total_shares_issued as u128)
        .ok_or(ErrorCode::InvalidNumericConversion)?;
    
    let total_withdrawal_value = (total_vault_value as u128)
        .checked_mul(withdrawal_proportion)
        .ok_or(ErrorCode::InvalidNumericConversion)?
        .checked_div(PRECISION)
        .ok_or(ErrorCode::InvalidNumericConversion)? as u64;
    
    Ok(total_withdrawal_value)
}

fn burn_user_shares<'info>(
    ctx: &Context<'_, '_, '_, 'info, Withdraw<'info>>,
    shares: u64
) -> Result<()> {
    let burn_accounts = token_interface::Burn {
        mint: ctx.accounts.mint.to_account_info(),
        from: ctx.accounts.user_vault_token_account.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    let burn_context = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        burn_accounts
    );
    token_interface::burn(burn_context, shares)
}

fn execute_pool_withdrawals<'info>(
    ctx: &Context<'_, '_, 'info, 'info, Withdraw<'info>>,
    vault: &Account<'info, Vault>,
    pool_values: &[PoolValue],
    total_withdrawal_value: u64,
    total_vault_value: u64,
    vault_signer_seeds: &[&[&[u8]]]
) -> Result<()> {
    for (i, pool_value) in pool_values.iter().enumerate() {
        if pool_value.sol_value == 0 {
            continue; // Skip empty pools
        }
        
        let pool_accounts = get_pool_accounts(&ctx.remaining_accounts, i);
        let pool_withdrawal_value = calculate_pool_withdrawal_value(
            total_withdrawal_value,
            pool_value.sol_value,
            total_vault_value
        )?;
        
        if pool_withdrawal_value > 0 {
            let pool_tokens_to_withdraw = calculate_pool_tokens_to_withdraw(
                pool_value.token_balance,
                pool_withdrawal_value,
                pool_value.sol_value
            )?;
            
            if pool_tokens_to_withdraw > 0 {
                execute_stake_pool_withdrawal(
                    ctx,
                    vault,
                    &pool_accounts,
                    pool_tokens_to_withdraw,
                    vault_signer_seeds
                )?;
            }
        }
    }
    
    Ok(())
}

fn calculate_pool_withdrawal_value(
    total_withdrawal_value: u64,
    pool_sol_value: u64,
    total_vault_value: u64
) -> Result<u64> {
    let pool_withdrawal_value = (total_withdrawal_value as u128)
        .checked_mul(pool_sol_value as u128)
        .ok_or(ErrorCode::InvalidNumericConversion)?
        .checked_div(total_vault_value as u128)
        .ok_or(ErrorCode::InvalidNumericConversion)? as u64;
    
    Ok(pool_withdrawal_value)
}

fn calculate_pool_tokens_to_withdraw(
    vault_pool_balance: u64,
    pool_withdrawal_value: u64,
    pool_sol_value: u64
) -> Result<u64> {
    let pool_tokens_to_withdraw = (vault_pool_balance as u128)
        .checked_mul(pool_withdrawal_value as u128)
        .ok_or(ErrorCode::InvalidNumericConversion)?
        .checked_div(pool_sol_value as u128)
        .ok_or(ErrorCode::InvalidNumericConversion)? as u64;
    
    // Ensure we don't try to withdraw more than we have
    Ok(pool_tokens_to_withdraw.min(vault_pool_balance))
}

fn execute_stake_pool_withdrawal<'info>(
    ctx: &Context<'_, '_, '_, 'info, Withdraw<'info>>,
    vault: &Account<'info, Vault>,
    pool_accounts: &PoolAccounts<'info>,
    pool_tokens_to_withdraw: u64,
    vault_signer_seeds: &[&[&[u8]]]
) -> Result<()> {
    let withdraw_instruction = spl_stake_pool::instruction::withdraw_sol(
        &ctx.accounts.stake_pool_program.key(),
        &pool_accounts.stake_pool.key(),
        &pool_accounts.withdraw_authority.key(),
        &vault.key(),
        &pool_accounts.vault_pool_token_account.key(),
        &pool_accounts.reserve_stake.key(),
        &ctx.accounts.signer.key(),
        &pool_accounts.manager_fee.key(),
        &pool_accounts.pool_mint.key(),
        &ctx.accounts.token_program.key(),
        pool_tokens_to_withdraw,
    );

    anchor_lang::solana_program::program::invoke_signed(
        &withdraw_instruction,
        &[
            pool_accounts.stake_pool.to_account_info(),
            pool_accounts.withdraw_authority.to_account_info(),
            vault.to_account_info(),
            pool_accounts.vault_pool_token_account.to_account_info(),
            pool_accounts.reserve_stake.to_account_info(),
            ctx.accounts.signer.to_account_info(),
            pool_accounts.manager_fee.to_account_info(),
            pool_accounts.pool_mint.to_account_info(),
            ctx.accounts.clock.to_account_info(),
            ctx.accounts.stake_history.to_account_info(),
            ctx.accounts.stake_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        vault_signer_seeds,
    )?;
    
    Ok(())
}
