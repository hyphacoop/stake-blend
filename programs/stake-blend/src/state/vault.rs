use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PoolProtocol {
    SplStakePool,
    Marinade,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub vault_id: u64,
    #[max_len(10)] // reasonable max of 10 stake pools
    pub stake_pools: Vec<Pubkey>,
    #[max_len(10)]
    pub pool_mints: Vec<Pubkey>,
    #[max_len(10)]
    pub allocations: Vec<u16>, // basis points (10000 = 100%)
    #[max_len(10)]
    pub pool_protocols: Vec<PoolProtocol>, // protocol type for each pool
    #[max_len(10)]
    pub marinade_states: Vec<Option<Pubkey>>, // Marinade state account for Marinade pools, None for SPL pools
    pub total_shares_issued: u64,
    pub bump: u8,
}