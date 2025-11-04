#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface;
use anchor_spl::token_interface::spl_token_metadata_interface::borsh::BorshDeserialize;
use spl_stake_pool::state::StakePool;
use crate::instructions::dependencies;
use crate::state::*;
use crate::StakeBlendError;

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Deposit<'info> {
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
    // Remaining accounts: [stake_pool_0, withdraw_authority_0, reserve_stake_0, pool_mint_0, vault_pool_token_account_0, manager_fee_0, referrer_fee_0, ...]
}

/// Pool account references for deposit operations
struct PoolAccounts<'info> {
    stake_pool: &'info AccountInfo<'info>,
    withdraw_authority: &'info AccountInfo<'info>,
    reserve_stake: &'info AccountInfo<'info>,
    pool_mint: &'info AccountInfo<'info>,
    vault_pool_token_account: &'info AccountInfo<'info>,
    manager_fee: &'info AccountInfo<'info>,
    referrer_fee: &'info AccountInfo<'info>,
}

pub fn handler<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Deposit<'info>>,
    vault_id: u64,
    amount: u64
) -> Result<()> {
    let mint_bump = ctx.bumps.mint;
    let vault_id_bytes = vault_id.to_le_bytes();
    let mint_signer_seeds: &[&[&[u8]]] = &[&[b"mint", vault_id_bytes.as_ref(), &[mint_bump]]];

    // Validate account structure
    let total_pools = ctx.accounts.vault.stake_pools.len();
    validate_remaining_accounts(&ctx, total_pools)?;
    
    // Validate accounts and calculate current vault value
    let total_vault_value = validate_and_calculate_vault_value(&ctx, &ctx.accounts.vault)?;
    
    // Calculate shares to mint based on current share price
    let shares_to_mint = calculate_shares_to_mint(amount, ctx.accounts.vault.total_shares_issued, total_vault_value)?;
    
    // Execute deposits to all pools
    execute_pool_deposits(&ctx, &ctx.accounts.vault, amount)?;
    
    // Mint shares to user
    mint_shares_to_user(&ctx, shares_to_mint, mint_signer_seeds)?;
    
    // Update vault state
    ctx.accounts.vault.total_shares_issued += shares_to_mint;

    Ok(())
}

fn validate_remaining_accounts<'info>(
    ctx: &Context<'_, '_, '_, 'info, Deposit<'info>>,
    total_pools: usize
) -> Result<()> {
    const ACCOUNTS_PER_POOL: usize = 7; // Includes referrer fee for deposits

    require!(
        ctx.remaining_accounts.len() == total_pools * ACCOUNTS_PER_POOL,
        ErrorCode::AccountNotEnoughKeys
    );
    require!(total_pools >= 1, ErrorCode::AccountNotEnoughKeys);

    Ok(())
}

fn validate_and_calculate_vault_value<'info>(
    ctx: &Context<'_, '_, 'info, 'info, Deposit<'info>>,
    vault: &Vault
) -> Result<u64> {
    let total_pools = vault.stake_pools.len();
    let mut total_vault_value = 0u64;
    
    for i in 0..total_pools {
        let pool_accounts = get_pool_accounts(&ctx.remaining_accounts, i);
        
        // Validate account keys match vault configuration
        validate_pool_account_keys(&pool_accounts, vault, i)?;
        
        // Get current pool token balance
        let vault_pool_balance = get_token_account_balance(pool_accounts.vault_pool_token_account)?;
        
        // Deserialize stake pool and validate derived accounts
        let stake_pool = deserialize_stake_pool(pool_accounts.stake_pool)?;
        validate_derived_accounts(&pool_accounts, &stake_pool, &ctx.accounts.stake_pool_program.key())?;
        
        // Calculate SOL value if we have tokens
        if vault_pool_balance > 0 {
            let pool_sol_value = stake_pool.calc_lamports_withdraw_amount(vault_pool_balance)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
            total_vault_value = total_vault_value.checked_add(pool_sol_value)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
        }
    }
    
    Ok(total_vault_value)
}

fn get_pool_accounts<'info>(remaining_accounts: &'info [AccountInfo<'info>], pool_index: usize) -> PoolAccounts<'info> {
    let base_idx = pool_index * 7;
    PoolAccounts {
        stake_pool: &remaining_accounts[base_idx],
        withdraw_authority: &remaining_accounts[base_idx + 1],
        reserve_stake: &remaining_accounts[base_idx + 2],
        pool_mint: &remaining_accounts[base_idx + 3],
        vault_pool_token_account: &remaining_accounts[base_idx + 4],
        manager_fee: &remaining_accounts[base_idx + 5],
        referrer_fee: &remaining_accounts[base_idx + 6],
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

fn calculate_shares_to_mint(
    amount: u64,
    total_shares_issued: u64,
    total_vault_value: u64
) -> Result<u64> {
    let shares_to_mint = if total_shares_issued == 0 {
        // First deposit: mint 1:1
        amount
    } else {
        // Calculate current share price: total_vault_value / total_shares_issued
        // Then: shares_to_mint = amount / share_price = amount * total_shares_issued / total_vault_value
        (amount as u128)
            .checked_mul(total_shares_issued as u128)
            .ok_or(ErrorCode::InvalidNumericConversion)?
            .checked_div(total_vault_value as u128)
            .ok_or(ErrorCode::InvalidNumericConversion)? as u64
    };
    
    Ok(shares_to_mint)
}

fn execute_pool_deposits<'info>(
    ctx: &Context<'_, '_, 'info, 'info, Deposit<'info>>,
    vault: &Vault,
    amount: u64
) -> Result<()> {
    let total_pools = vault.stake_pools.len();
    
    for i in 0..total_pools {
        let pool_amount = calculate_pool_allocation(amount, vault.allocations[i]);
        
        if pool_amount > 0 {
            let pool_accounts = get_pool_accounts(&ctx.remaining_accounts, i);
            execute_stake_pool_deposit(ctx, &pool_accounts, pool_amount)?;
        }
    }
    
    Ok(())
}

fn calculate_pool_allocation(total_amount: u64, allocation_bps: u16) -> u64 {
    const BASIS_POINTS: u128 = 10000;
    (total_amount as u128 * allocation_bps as u128 / BASIS_POINTS) as u64
}

fn execute_stake_pool_deposit<'info>(
    ctx: &Context<'_, '_, '_, 'info, Deposit<'info>>,
    pool_accounts: &PoolAccounts<'info>,
    pool_amount: u64
) -> Result<()> {
    let deposit_instruction = spl_stake_pool::instruction::deposit_sol(
        &ctx.accounts.stake_pool_program.key(),
        &pool_accounts.stake_pool.key(),
        &pool_accounts.withdraw_authority.key(),
        &pool_accounts.reserve_stake.key(),
        &ctx.accounts.signer.key(),
        &pool_accounts.vault_pool_token_account.key(),
        &pool_accounts.manager_fee.key(),
        &pool_accounts.referrer_fee.key(),
        &pool_accounts.pool_mint.key(),
        &ctx.accounts.token_program.key(),
        pool_amount,
    );

    anchor_lang::solana_program::program::invoke(
        &deposit_instruction,
        &[
            pool_accounts.stake_pool.to_account_info(),
            pool_accounts.withdraw_authority.to_account_info(),
            pool_accounts.reserve_stake.to_account_info(),
            ctx.accounts.signer.to_account_info(),
            pool_accounts.vault_pool_token_account.to_account_info(),
            pool_accounts.manager_fee.to_account_info(),
            pool_accounts.referrer_fee.to_account_info(),
            pool_accounts.pool_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.stake_pool_program.to_account_info(),
        ],
    )?;
    
    Ok(())
}

fn mint_shares_to_user<'info>(
    ctx: &Context<'_, '_, '_, 'info, Deposit<'info>>,
    shares_to_mint: u64,
    mint_signer_seeds: &[&[&[u8]]]
) -> Result<()> {
    let cpi_accounts = token_interface::MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.user_vault_token_account.to_account_info(),
        authority: ctx.accounts.mint.to_account_info(),
    };
    let cpi_context = CpiContext::new(
        ctx.accounts.token_program.to_account_info(), 
        cpi_accounts
    ).with_signer(mint_signer_seeds);
    
    token_interface::mint_to(cpi_context, shares_to_mint)
}
