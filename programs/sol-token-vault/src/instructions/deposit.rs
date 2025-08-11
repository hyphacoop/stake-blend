#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
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

    // Accounts for first stake pool only
    /// CHECK: Stake pool program account  
    #[account(mut)]
    pub stake_pool: UncheckedAccount<'info>,
    /// CHECK: Stake pool withdraw authority
    pub withdraw_authority: UncheckedAccount<'info>,
    /// CHECK: Reserve stake account
    #[account(mut)]
    pub reserve_stake_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub pool_mint: InterfaceAccount<'info, token_interface::Mint>,
    #[account(mut)]
    pub vault_pool_token_account: InterfaceAccount<'info, token_interface::TokenAccount>,
    /// CHECK: Manager fee account
    #[account(mut)]
    pub manager_fee_account: UncheckedAccount<'info>,
    /// CHECK: Referrer fee account (can be same as manager fee account)
    #[account(mut)]
    pub referrer_fee_account: UncheckedAccount<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    /// CHECK: Stake pool program
    pub stake_pool_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let mint_bump = ctx.bumps.mint;
    let signer_seeds: &[&[&[u8]]] = &[&[b"mint", &[mint_bump]]];

    // Use allocation for first pool (for now, just deposit to first pool)
    let pool_amount = (amount as u128 * vault.allocations[0] as u128 / 10000) as u64;

    if pool_amount > 0 {
        let deposit_instruction = spl_stake_pool::instruction::deposit_sol(
            &ctx.accounts.stake_pool_program.key(),
            &ctx.accounts.stake_pool.key(),
            &ctx.accounts.withdraw_authority.key(),
            &ctx.accounts.reserve_stake_account.key(),
            &ctx.accounts.signer.key(),
            &ctx.accounts.vault_pool_token_account.key(),
            &ctx.accounts.manager_fee_account.key(),
            &ctx.accounts.referrer_fee_account.key(),
            &ctx.accounts.pool_mint.key(),
            &ctx.accounts.token_program.key(),
            pool_amount,
        );

        anchor_lang::solana_program::program::invoke(
            &deposit_instruction,
            &[
                ctx.accounts.stake_pool.to_account_info(),
                ctx.accounts.withdraw_authority.to_account_info(),
                ctx.accounts.reserve_stake_account.to_account_info(),
                ctx.accounts.signer.to_account_info(),
                ctx.accounts.vault_pool_token_account.to_account_info(),
                ctx.accounts.manager_fee_account.to_account_info(),
                ctx.accounts.referrer_fee_account.to_account_info(),
                ctx.accounts.pool_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.stake_pool_program.to_account_info(),
            ],
        )?;
    }

    // For now, mint 1:1 vault shares (we'll improve this later with proper pricing)
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