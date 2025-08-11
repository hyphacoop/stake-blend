use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    #[max_len(10)] // reasonable max of 10 stake pools
    pub stake_pools: Vec<Pubkey>,
    #[max_len(10)]
    pub pool_mints: Vec<Pubkey>,
    #[max_len(10)]
    pub allocations: Vec<u16>, // basis points (10000 = 100%)
    pub total_shares_issued: u64,
    pub bump: u8,
}