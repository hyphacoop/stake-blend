use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_spl::token_interface::spl_token_metadata_interface::borsh::BorshDeserialize;
use spl_stake_pool::state::StakePool;
use crate::StakeBlendError;

/// Pool account references for SPL Stake Pool deposit operations
pub struct SplPoolDepositAccounts<'info> {
    pub stake_pool: &'info AccountInfo<'info>,
    pub withdraw_authority: &'info AccountInfo<'info>,
    pub reserve_stake: &'info AccountInfo<'info>,
    pub pool_mint: &'info AccountInfo<'info>,
    pub vault_pool_token_account: &'info AccountInfo<'info>,
    pub manager_fee: &'info AccountInfo<'info>,
    pub referrer_fee: &'info AccountInfo<'info>,
}

/// Pool account references for SPL Stake Pool withdraw operations
pub struct SplPoolWithdrawAccounts<'info> {
    pub stake_pool: &'info AccountInfo<'info>,
    pub withdraw_authority: &'info AccountInfo<'info>,
    pub pool_mint: &'info AccountInfo<'info>,
    pub reserve_stake: &'info AccountInfo<'info>,
    pub vault_pool_token_account: &'info AccountInfo<'info>,
    pub manager_fee: &'info AccountInfo<'info>,
}

impl<'info> SplPoolDepositAccounts<'info> {
    /// Parse SPL stake pool deposit accounts from remaining_accounts starting at offset
    pub fn parse(remaining_accounts: &'info [AccountInfo<'info>], offset: usize) -> Self {
        Self {
            stake_pool: &remaining_accounts[offset],
            withdraw_authority: &remaining_accounts[offset + 1],
            reserve_stake: &remaining_accounts[offset + 2],
            pool_mint: &remaining_accounts[offset + 3],
            vault_pool_token_account: &remaining_accounts[offset + 4],
            manager_fee: &remaining_accounts[offset + 5],
            referrer_fee: &remaining_accounts[offset + 6],
        }
    }

    /// Validate account keys match vault configuration
    pub fn validate_keys(&self, vault: &crate::state::Vault, pool_index: usize) -> Result<()> {
        require!(
            self.stake_pool.key() == vault.stake_pools[pool_index],
            StakeBlendError::InvalidAccountData
        );
        require!(
            self.pool_mint.key() == vault.pool_mints[pool_index],
            StakeBlendError::InvalidAccountData
        );
        Ok(())
    }

    /// Deserialize and validate the stake pool state
    pub fn deserialize_and_validate(&self, stake_pool_program_key: &Pubkey) -> Result<StakePool> {
        let stake_pool_data = self.stake_pool.try_borrow_data()?;
        let stake_pool = StakePool::deserialize(&mut stake_pool_data.as_ref())
            .map_err(|_| ErrorCode::AccountDidNotDeserialize)?;

        // Validate withdraw authority
        let (expected_withdraw_authority, _) = spl_stake_pool::find_withdraw_authority_program_address(
            stake_pool_program_key,
            &self.stake_pool.key(),
        );
        require!(
            self.withdraw_authority.key() == expected_withdraw_authority,
            StakeBlendError::InvalidAccountData
        );

        // Validate reserve stake
        require!(
            self.reserve_stake.key() == stake_pool.reserve_stake,
            StakeBlendError::InvalidAccountData
        );

        // Validate manager fee account
        require!(
            self.manager_fee.key() == stake_pool.manager_fee_account,
            StakeBlendError::InvalidAccountData
        );

        Ok(stake_pool)
    }

    /// Get the SOL value of pool tokens held by the vault
    pub fn get_pool_value(&self) -> Result<u64> {
        let vault_pool_balance = super::get_token_account_balance(self.vault_pool_token_account)?;

        if vault_pool_balance > 0 {
            let stake_pool_data = self.stake_pool.try_borrow_data()?;
            let stake_pool = StakePool::deserialize(&mut stake_pool_data.as_ref())
                .map_err(|_| ErrorCode::AccountDidNotDeserialize)?;

            let pool_sol_value = stake_pool.calc_lamports_withdraw_amount(vault_pool_balance)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
            Ok(pool_sol_value)
        } else {
            Ok(0)
        }
    }

    /// Execute deposit to SPL stake pool
    pub fn execute_deposit(
        &self,
        signer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        token_program: &AccountInfo<'info>,
        stake_pool_program: &AccountInfo<'info>,
        pool_amount: u64,
    ) -> Result<()> {
        let deposit_instruction = spl_stake_pool::instruction::deposit_sol(
            &stake_pool_program.key(),
            &self.stake_pool.key(),
            &self.withdraw_authority.key(),
            &self.reserve_stake.key(),
            &signer.key(),
            &self.vault_pool_token_account.key(),
            &self.manager_fee.key(),
            &self.referrer_fee.key(),
            &self.pool_mint.key(),
            &token_program.key(),
            pool_amount,
        );

        anchor_lang::solana_program::program::invoke(
            &deposit_instruction,
            &[
                self.stake_pool.to_account_info(),
                self.withdraw_authority.to_account_info(),
                self.reserve_stake.to_account_info(),
                signer.to_account_info(),
                self.vault_pool_token_account.to_account_info(),
                self.manager_fee.to_account_info(),
                self.referrer_fee.to_account_info(),
                self.pool_mint.to_account_info(),
                system_program.to_account_info(),
                token_program.to_account_info(),
                stake_pool_program.to_account_info(),
            ],
        )?;

        Ok(())
    }
}

impl<'info> SplPoolWithdrawAccounts<'info> {
    /// Parse SPL stake pool withdraw accounts from remaining_accounts starting at offset
    pub fn parse(remaining_accounts: &'info [AccountInfo<'info>], offset: usize) -> Self {
        Self {
            stake_pool: &remaining_accounts[offset],
            withdraw_authority: &remaining_accounts[offset + 1],
            reserve_stake: &remaining_accounts[offset + 2],
            pool_mint: &remaining_accounts[offset + 3],
            vault_pool_token_account: &remaining_accounts[offset + 4],
            manager_fee: &remaining_accounts[offset + 5],
        }
    }

    /// Get the SOL value of pool tokens held by the vault
    pub fn get_pool_value(&self) -> Result<u64> {
        let vault_pool_balance = super::get_token_account_balance(self.vault_pool_token_account)?;

        if vault_pool_balance > 0 {
            let stake_pool_data = self.stake_pool.try_borrow_data()?;
            let stake_pool = StakePool::deserialize(&mut stake_pool_data.as_ref())
                .map_err(|_| ErrorCode::AccountDidNotDeserialize)?;

            let pool_sol_value = stake_pool.calc_lamports_withdraw_amount(vault_pool_balance)
                .ok_or(ErrorCode::InvalidNumericConversion)?;
            Ok(pool_sol_value)
        } else {
            Ok(0)
        }
    }

    /// Execute withdrawal from SPL stake pool
    pub fn execute_withdraw(
        &self,
        vault: &AccountInfo<'info>,
        token_program: &AccountInfo<'info>,
        clock: &AccountInfo<'info>,
        stake_history: &AccountInfo<'info>,
        stake_program: &AccountInfo<'info>,
        user: &AccountInfo<'info>,
        pool_token_amount: u64,
        vault_signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        // Note: The SPL Stake Pool program ID is derived from stake_program context
        // since we don't have a separate stake_pool_program parameter
        let stake_pool_program_id = spl_stake_pool::ID;
        let withdraw_instruction = spl_stake_pool::instruction::withdraw_sol(
            &stake_pool_program_id,
            &self.stake_pool.key(),
            &self.withdraw_authority.key(),
            &vault.key(),
            &self.vault_pool_token_account.key(),
            &self.reserve_stake.key(),
            &user.key(),
            &self.manager_fee.key(),
            &self.pool_mint.key(),
            &token_program.key(),
            pool_token_amount,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &withdraw_instruction,
            &[
                self.stake_pool.to_account_info(),
                self.withdraw_authority.to_account_info(),
                vault.to_account_info(),
                self.vault_pool_token_account.to_account_info(),
                self.reserve_stake.to_account_info(),
                user.to_account_info(),
                self.manager_fee.to_account_info(),
                self.pool_mint.to_account_info(),
                clock.to_account_info(),
                stake_history.to_account_info(),
                stake_program.to_account_info(),
                token_program.to_account_info(),
            ],
            vault_signer_seeds,
        )?;

        Ok(())
    }
}
