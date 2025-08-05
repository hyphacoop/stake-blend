#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

pub mod state;
pub mod instructions;
use instructions::*;

declare_id!("3uUWcoJawNHKnsann7Vrw9LzVhMxgnNUuDeXYuZikYYT");

#[program]
pub mod sol_token_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }

    pub fn create_user_account(ctx: Context<CreateUserAccount>) -> Result<()> {
        create_user_account::handler(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        deposit::handler(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        withdraw::handler(ctx, shares)
    }
}