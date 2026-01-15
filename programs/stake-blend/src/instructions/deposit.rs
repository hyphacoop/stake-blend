#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface;
use crate::instructions::dependencies;
use crate::state::*;
use crate::protocols::*;

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
    // Remaining accounts vary by protocol:
    // SPL Stake Pool (7 accounts): stake_pool, withdraw_authority, reserve_stake, pool_mint, vault_pool_token_account, manager_fee, referrer_fee
    // Marinade (11 accounts): marinade_state, msol_mint, liq_pool_sol_leg_pda, liq_pool_msol_leg, liq_pool_msol_leg_authority, reserve_pda, vault_msol_token_account, msol_mint_authority, system_program, token_program, marinade_program
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
    validate_remaining_accounts(&ctx, &ctx.accounts.vault)?;
    
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
    vault: &Vault
) -> Result<()> {
    let total_pools = vault.stake_pools.len();
    require!(total_pools >= 1, ErrorCode::AccountNotEnoughKeys);

    // Calculate expected number of accounts based on protocol types
    let expected_accounts: usize = vault.pool_protocols.iter()
        .map(|protocol| deposit_accounts_per_pool(protocol))
        .sum();

    require!(
        ctx.remaining_accounts.len() == expected_accounts,
        ErrorCode::AccountNotEnoughKeys
    );

    Ok(())
}

fn validate_and_calculate_vault_value<'info>(
    ctx: &Context<'_, '_, 'info, 'info, Deposit<'info>>,
    vault: &Vault
) -> Result<u64> {
    let total_pools = vault.stake_pools.len();
    let mut total_vault_value = 0u64;
    let mut offset = 0;

    for i in 0..total_pools {
        let protocol = &vault.pool_protocols[i];

        let pool_value = match protocol {
            PoolProtocol::SplStakePool => {
                let pool_accounts = SplPoolDepositAccounts::parse(&ctx.remaining_accounts, offset);
                pool_accounts.validate_keys(vault, i)?;
                pool_accounts.deserialize_and_validate(&ctx.accounts.stake_pool_program.key())?;
                pool_accounts.get_pool_value()?
            },
            PoolProtocol::Marinade => {
                let pool_accounts = MarinadePoolDepositAccounts::parse(&ctx.remaining_accounts, offset);
                pool_accounts.validate_keys(vault, i)?;
                pool_accounts.get_pool_value()?
            },
        };

        total_vault_value = total_vault_value.checked_add(pool_value)
            .ok_or(ErrorCode::InvalidNumericConversion)?;

        offset += deposit_accounts_per_pool(protocol);
    }

    Ok(total_vault_value)
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
    let mut offset = 0;

    for i in 0..total_pools {
        let pool_amount = calculate_pool_allocation(amount, vault.allocations[i]);
        let protocol = &vault.pool_protocols[i];

        if pool_amount > 0 {
            match protocol {
                PoolProtocol::SplStakePool => {
                    let pool_accounts = SplPoolDepositAccounts::parse(&ctx.remaining_accounts, offset);
                    pool_accounts.execute_deposit(
                        &ctx.accounts.signer.to_account_info(),
                        &ctx.accounts.system_program.to_account_info(),
                        &ctx.accounts.token_program.to_account_info(),
                        &ctx.accounts.stake_pool_program.to_account_info(),
                        pool_amount,
                    )?;
                },
                PoolProtocol::Marinade => {
                    let pool_accounts = MarinadePoolDepositAccounts::parse(&ctx.remaining_accounts, offset);
                    pool_accounts.execute_deposit(
                        &ctx.accounts.signer.to_account_info(),
                        &ctx.accounts.system_program.to_account_info(),
                        &ctx.accounts.token_program.to_account_info(),
                        pool_amount,
                    )?;
                },
            }
        }

        offset += deposit_accounts_per_pool(protocol);
    }

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
