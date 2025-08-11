#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface;
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

    // Accounts for stake pool withdraw
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

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    /// CHECK: Stake pool program
    pub stake_pool_program: UncheckedAccount<'info>,
    /// CHECK: Clock sysvar
    pub clock: UncheckedAccount<'info>,
    /// CHECK: Stake history sysvar  
    pub stake_history: UncheckedAccount<'info>,
    /// CHECK: Stake program
    pub stake_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let vault_bump = ctx.bumps.vault;
    let vault_signer_seeds: &[&[&[u8]]] = &[&[b"vault", &[vault_bump]]];

    // Burn vault shares from user
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

    // For now, assume 1:1 conversion (we'll improve this later)
    let pool_tokens_to_withdraw = shares;

    // Use the proper spl-stake-pool instruction instead of manual construction
    let withdraw_instruction = spl_stake_pool::instruction::withdraw_sol(
        &ctx.accounts.stake_pool_program.key(),
        &ctx.accounts.stake_pool.key(),
        &ctx.accounts.withdraw_authority.key(),
        &vault.key(), // vault as user transfer authority
        &ctx.accounts.vault_pool_token_account.key(),
        &ctx.accounts.reserve_stake_account.key(),
        &ctx.accounts.signer.key(), // user receives SOL
        &ctx.accounts.manager_fee_account.key(),
        &ctx.accounts.pool_mint.key(),
        &ctx.accounts.token_program.key(),
        pool_tokens_to_withdraw,
    );

    anchor_lang::solana_program::program::invoke_signed(
        &withdraw_instruction,
        &[
            ctx.accounts.stake_pool.to_account_info(),
            ctx.accounts.withdraw_authority.to_account_info(),
            vault.to_account_info(),
            ctx.accounts.vault_pool_token_account.to_account_info(),
            ctx.accounts.reserve_stake_account.to_account_info(),
            ctx.accounts.signer.to_account_info(),
            ctx.accounts.manager_fee_account.to_account_info(),
            ctx.accounts.pool_mint.to_account_info(),
            ctx.accounts.clock.to_account_info(),
            ctx.accounts.stake_history.to_account_info(),
            ctx.accounts.stake_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        vault_signer_seeds,
    )?;

    vault.total_shares_issued -= shares;

    Ok(())
}