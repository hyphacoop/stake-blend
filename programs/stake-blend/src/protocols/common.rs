use anchor_lang::prelude::*;

/// Number of accounts required per pool for deposits, by protocol type
pub fn deposit_accounts_per_pool(protocol: &crate::state::PoolProtocol) -> usize {
    match protocol {
        crate::state::PoolProtocol::SplStakePool => 7,
        crate::state::PoolProtocol::Marinade => 11,
    }
}

/// Number of accounts required per pool for withdrawals, by protocol type
pub fn withdraw_accounts_per_pool(protocol: &crate::state::PoolProtocol) -> usize {
    match protocol {
        crate::state::PoolProtocol::SplStakePool => 6,
        crate::state::PoolProtocol::Marinade => 9,  // 6 pool-specific + system_program + token_program + marinade_program
    }
}

/// Calculate the starting index in remaining_accounts for a given pool
pub fn get_pool_account_offset(
    pool_index: usize,
    protocols: &[crate::state::PoolProtocol],
    is_deposit: bool,
) -> usize {
    let mut offset = 0;
    for i in 0..pool_index {
        offset += if is_deposit {
            deposit_accounts_per_pool(&protocols[i])
        } else {
            withdraw_accounts_per_pool(&protocols[i])
        };
    }
    offset
}

/// Get token account balance from account info
pub fn get_token_account_balance(token_account: &AccountInfo) -> Result<u64> {
    let account_data = token_account.try_borrow_data()?;
    let token_account = anchor_spl::token::TokenAccount::try_deserialize(&mut account_data.as_ref())?;
    Ok(token_account.amount)
}

/// Calculate allocation amount based on basis points
pub fn calculate_pool_allocation(total_amount: u64, allocation_bps: u16) -> u64 {
    const BASIS_POINTS: u128 = 10000;
    (total_amount as u128 * allocation_bps as u128 / BASIS_POINTS) as u64
}
