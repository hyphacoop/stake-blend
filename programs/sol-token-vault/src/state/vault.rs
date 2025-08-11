use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub stake_pools: [Pubkey; 1],
    pub pool_mints: [Pubkey; 1],
    pub allocations: [u16; 1], // basis points (10000 = 100%)
    pub total_shares_issued: u64,
    pub bump: u8,
}