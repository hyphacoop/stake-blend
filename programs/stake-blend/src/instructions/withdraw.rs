#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface;
use anchor_spl::stake::Stake;
use crate::instructions::dependencies;
use crate::state::*;
use crate::protocols::*;
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
    // Remaining accounts vary by protocol:
    // SPL Stake Pool (6 accounts): stake_pool, withdraw_authority, pool_mint, reserve_stake, vault_pool_token_account, manager_fee
    // Marinade (10 accounts): marinade_state, msol_mint, liq_pool_sol_leg_pda, liq_pool_msol_leg, treasury_msol_account, vault_msol_token_account, vault_authority, user, system_program, token_program
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
    validate_remaining_accounts(&ctx, &ctx.accounts.vault)?;
    
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
    vault: &Vault
) -> Result<()> {
    let total_pools = vault.stake_pools.len();
    require!(total_pools >= 1, ErrorCode::AccountNotEnoughKeys);

    // Calculate expected number of accounts based on protocol types
    let expected_accounts: usize = vault.pool_protocols.iter()
        .map(|protocol| withdraw_accounts_per_pool(protocol))
        .sum();

    require!(
        ctx.remaining_accounts.len() == expected_accounts,
        ErrorCode::AccountNotEnoughKeys
    );

    Ok(())
}

fn validate_and_calculate_pool_values<'info>(
    ctx: &Context<'_, '_, 'info, 'info, Withdraw<'info>>,
    vault: &Vault
) -> Result<Vec<PoolValue>> {
    let total_pools = vault.stake_pools.len();
    let mut pool_values = Vec::with_capacity(total_pools);
    let mut offset = 0;

    for i in 0..total_pools {
        let protocol = &vault.pool_protocols[i];

        let (sol_value, token_balance) = match protocol {
            PoolProtocol::SplStakePool => {
                let pool_accounts = SplPoolWithdrawAccounts::parse(&ctx.remaining_accounts, offset);
                // Note: SplPoolWithdrawAccounts doesn't have validate_keys or deserialize methods
                // We'll add simplified validation here
                require!(
                    pool_accounts.stake_pool.key() == vault.stake_pools[i],
                    StakeBlendError::InvalidAccountData
                );
                require!(
                    pool_accounts.pool_mint.key() == vault.pool_mints[i],
                    StakeBlendError::InvalidAccountData
                );

                let value = pool_accounts.get_pool_value()?;
                let balance = get_token_account_balance(pool_accounts.vault_pool_token_account)?;
                (value, balance)
            },
            PoolProtocol::Marinade => {
                let pool_accounts = MarinadePoolWithdrawAccounts::parse(&ctx.remaining_accounts, offset);
                // Validate Marinade state
                let expected_state = vault.marinade_states[i]
                    .ok_or(StakeBlendError::InvalidAccountData)?;
                require!(
                    pool_accounts.marinade_state.key() == expected_state,
                    StakeBlendError::InvalidAccountData
                );
                require!(
                    pool_accounts.msol_mint.key() == vault.pool_mints[i],
                    StakeBlendError::InvalidAccountData
                );

                let value = pool_accounts.get_pool_value()?;
                let balance = get_token_account_balance(pool_accounts.vault_msol_token_account)?;
                (value, balance)
            },
        };

        pool_values.push(PoolValue { sol_value, token_balance });
        offset += withdraw_accounts_per_pool(protocol);
    }

    Ok(pool_values)
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
    let mut offset = 0;

    for (i, pool_value) in pool_values.iter().enumerate() {
        let protocol = &vault.pool_protocols[i];

        if pool_value.sol_value == 0 {
            offset += withdraw_accounts_per_pool(protocol);
            continue; // Skip empty pools
        }

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
                match protocol {
                    PoolProtocol::SplStakePool => {
                        let pool_accounts = SplPoolWithdrawAccounts::parse(&ctx.remaining_accounts, offset);
                        pool_accounts.execute_withdraw(
                            &vault.to_account_info(),
                            &ctx.accounts.token_program.to_account_info(),
                            &ctx.accounts.clock.to_account_info(),
                            &ctx.accounts.stake_history.to_account_info(),
                            &ctx.accounts.stake_program.to_account_info(),
                            &ctx.accounts.signer.to_account_info(),
                            pool_tokens_to_withdraw,
                            vault_signer_seeds,
                        )?;
                    },
                    PoolProtocol::Marinade => {
                        let pool_accounts = MarinadePoolWithdrawAccounts::parse(&ctx.remaining_accounts, offset);
                        pool_accounts.execute_withdraw(
                            &vault.to_account_info(),
                            &ctx.accounts.signer.to_account_info(),
                            pool_tokens_to_withdraw,
                            vault_signer_seeds,
                        )?;
                    },
                }
            }
        }

        offset += withdraw_accounts_per_pool(protocol);
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

