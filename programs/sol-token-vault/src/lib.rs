#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

pub mod state;
pub mod instructions;
use instructions::*;

declare_id!("3uUWcoJawNHKnsann7Vrw9LzVhMxgnNUuDeXYuZikYYT");

#[program]
pub mod sol_token_vault {
    use super::*;

    pub fn initialize<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, Initialize<'info>>, allocations: Vec<u16>
    ) -> Result<()> {
        initialize::handler(ctx, allocations)
    }

    pub fn create_user_account(ctx: Context<CreateUserAccount>) -> Result<()> {
        create_user_account::handler(ctx)
    }

    pub fn deposit<'c: 'info, 'info>(ctx: Context<'_, '_, 'c,'info, Deposit<'info>>, amount: u64) -> Result<()> {
        deposit::handler(ctx, amount)
    }

    pub fn withdraw<'c: 'info, 'info>(ctx: Context<'_, '_, 'c, 'info, Withdraw<'info>>, shares: u64) -> Result<()> {
        withdraw::handler(ctx, shares)
    }
}