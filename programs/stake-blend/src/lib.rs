#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;
pub mod protocols;
use instructions::*;

// declare_id!("3uUWcoJawNHKnsann7Vrw9LzVhMxgnNUuDeXYuZikYYT");
declare_id!("Cw3KHMs521Ge3d4xETA6wGwqVNnY7z2xwz6Dtb2Fkp6t");

#[program]
pub mod stake_blend {
    use super::*;

    pub fn initialize<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, Initialize<'info>>,
        vault_id: u64,
        allocations: Vec<u16>,
        pool_protocols: Vec<state::PoolProtocol>,
        marinade_states: Vec<Option<Pubkey>>,
    ) -> Result<()> {
        initialize::handler(ctx, vault_id, allocations, pool_protocols, marinade_states)
    }

    pub fn create_user_account(ctx: Context<CreateUserAccount>, vault_id: u64) -> Result<()> {
        create_user_account::handler(ctx, vault_id)
    }

    pub fn deposit<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, Deposit<'info>>,
        vault_id: u64,
        amount: u64,
    ) -> Result<()> {
        deposit::handler(ctx, vault_id, amount)
    }

    pub fn withdraw<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, Withdraw<'info>>,
        vault_id: u64,
        shares: u64,
    ) -> Result<()> {
        withdraw::handler(ctx, vault_id, shares)
    }
}

#[error_code]
pub enum StakeBlendError {
    #[msg("Invalid account data provided")]
    InvalidAccountData,
}
