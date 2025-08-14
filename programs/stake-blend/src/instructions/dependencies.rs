use spl_stake_pool::ID;
use anchor_lang::prelude::Pubkey;

#[derive(Debug, Clone)]
pub struct StakePool;

impl anchor_lang::Id for StakePool {
    fn id() -> Pubkey {
        ID
    }
}
