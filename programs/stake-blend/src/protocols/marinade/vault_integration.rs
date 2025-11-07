/// Vault-specific integration logic for Marinade protocol
/// This module contains account structures and validation specific to our vault implementation

use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use crate::StakeBlendError;
use super::interface::*;

/// Pool account references for Marinade deposit operations (vault-specific)
pub struct MarinadePoolDepositAccounts<'info> {
    pub marinade_state: &'info AccountInfo<'info>,
    pub msol_mint: &'info AccountInfo<'info>,
    pub liq_pool_sol_leg_pda: &'info AccountInfo<'info>,
    pub liq_pool_msol_leg: &'info AccountInfo<'info>,
    pub liq_pool_msol_leg_authority: &'info AccountInfo<'info>,
    pub reserve_pda: &'info AccountInfo<'info>,
    pub vault_msol_token_account: &'info AccountInfo<'info>,
    pub msol_mint_authority: &'info AccountInfo<'info>,
    // system_program, token_program passed separately in execute methods
}

/// Pool account references for Marinade withdraw (liquid unstake) operations (vault-specific)
pub struct MarinadePoolWithdrawAccounts<'info> {
    pub marinade_state: &'info AccountInfo<'info>,
    pub msol_mint: &'info AccountInfo<'info>,
    pub liq_pool_sol_leg_pda: &'info AccountInfo<'info>,
    pub liq_pool_msol_leg: &'info AccountInfo<'info>,
    pub treasury_msol_account: &'info AccountInfo<'info>,
    pub vault_msol_token_account: &'info AccountInfo<'info>,
    pub system_program: &'info AccountInfo<'info>,
    pub token_program: &'info AccountInfo<'info>,
    pub marinade_program: &'info AccountInfo<'info>,
    // vault authority and user are passed separately from main context
}

impl<'info> MarinadePoolDepositAccounts<'info> {
    /// Parse Marinade deposit accounts from remaining_accounts starting at offset
    pub fn parse(remaining_accounts: &'info [AccountInfo<'info>], offset: usize) -> Self {
        Self {
            marinade_state: &remaining_accounts[offset],
            msol_mint: &remaining_accounts[offset + 1],
            liq_pool_sol_leg_pda: &remaining_accounts[offset + 2],
            liq_pool_msol_leg: &remaining_accounts[offset + 3],
            liq_pool_msol_leg_authority: &remaining_accounts[offset + 4],
            reserve_pda: &remaining_accounts[offset + 5],
            vault_msol_token_account: &remaining_accounts[offset + 6],
            msol_mint_authority: &remaining_accounts[offset + 7],
            // Note: offset+8, offset+9, offset+10 are system_program, token_program, marinade_program
            // These are passed from the main context
        }
    }

    /// Validate account keys match vault configuration
    pub fn validate_keys(&self, vault: &crate::state::Vault, pool_index: usize) -> Result<()> {
        // Validate marinade state
        let expected_state = vault.marinade_states[pool_index]
            .ok_or(StakeBlendError::InvalidAccountData)?;
        require!(
            self.marinade_state.key() == expected_state,
            StakeBlendError::InvalidAccountData
        );

        // Validate mSOL mint
        require!(
            self.msol_mint.key() == vault.pool_mints[pool_index],
            StakeBlendError::InvalidAccountData
        );

        Ok(())
    }

    /// Get the SOL value of mSOL tokens held by the vault
    /// Uses Marinade's state to calculate the mSOL -> SOL conversion
    pub fn get_pool_value(&self) -> Result<u64> {
        let vault_msol_balance = super::super::get_token_account_balance(self.vault_msol_token_account)?;

        if vault_msol_balance > 0 {
            // Deserialize Marinade state to get mSOL price
            let state_data = self.marinade_state.try_borrow_data()?;
            let state = MarinadeState::deserialize(&mut state_data.as_ref())
                .map_err(|_| ErrorCode::AccountDidNotDeserialize)?;

            // Calculate SOL value using Marinade's price formula
            msol_to_sol(vault_msol_balance, state.msol_price)
        } else {
            Ok(0)
        }
    }

    /// Execute deposit to Marinade (mints mSOL for SOL)
    pub fn execute_deposit(
        &self,
        signer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        token_program: &AccountInfo<'info>,
        pool_amount: u64,
    ) -> Result<()> {
        let deposit_instruction = build_deposit_instruction(
            self.marinade_state.key(),
            self.msol_mint.key(),
            self.liq_pool_sol_leg_pda.key(),
            self.liq_pool_msol_leg.key(),
            self.liq_pool_msol_leg_authority.key(),
            self.reserve_pda.key(),
            signer.key(),
            self.vault_msol_token_account.key(),
            self.msol_mint_authority.key(),
            system_program.key(),
            token_program.key(),
            pool_amount,
        );

        anchor_lang::solana_program::program::invoke(
            &deposit_instruction,
            &[
                self.marinade_state.to_account_info(),
                self.msol_mint.to_account_info(),
                self.liq_pool_sol_leg_pda.to_account_info(),
                self.liq_pool_msol_leg.to_account_info(),
                self.liq_pool_msol_leg_authority.to_account_info(),
                self.reserve_pda.to_account_info(),
                signer.to_account_info(),
                self.vault_msol_token_account.to_account_info(),
                self.msol_mint_authority.to_account_info(),
                system_program.to_account_info(),
                token_program.to_account_info(),
            ],
        )?;

        Ok(())
    }
}

impl<'info> MarinadePoolWithdrawAccounts<'info> {
    /// Parse Marinade withdraw accounts from remaining_accounts starting at offset
    pub fn parse(remaining_accounts: &'info [AccountInfo<'info>], offset: usize) -> Self {
        Self {
            marinade_state: &remaining_accounts[offset],
            msol_mint: &remaining_accounts[offset + 1],
            liq_pool_sol_leg_pda: &remaining_accounts[offset + 2],
            liq_pool_msol_leg: &remaining_accounts[offset + 3],
            treasury_msol_account: &remaining_accounts[offset + 4],
            vault_msol_token_account: &remaining_accounts[offset + 5],
            system_program: &remaining_accounts[offset + 6],
            token_program: &remaining_accounts[offset + 7],
            marinade_program: &remaining_accounts[offset + 8],
        }
    }

    /// Get the SOL value of mSOL tokens held by the vault
    pub fn get_pool_value(&self) -> Result<u64> {
        let vault_msol_balance = super::super::get_token_account_balance(self.vault_msol_token_account)?;

        if vault_msol_balance > 0 {
            // Deserialize Marinade state to get mSOL price
            let state_data = self.marinade_state.try_borrow_data()?;
            let state = MarinadeState::deserialize(&mut state_data.as_ref())
                .map_err(|_| ErrorCode::AccountDidNotDeserialize)?;

            // Calculate SOL value using Marinade's price formula
            msol_to_sol(vault_msol_balance, state.msol_price)
        } else {
            Ok(0)
        }
    }

    /// Execute liquid unstake from Marinade (burns mSOL for SOL instantly via liquidity pool)
    pub fn execute_withdraw(
        &self,
        vault: &AccountInfo<'info>,
        user: &AccountInfo<'info>,
        msol_amount: u64,
        vault_signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        let unstake_instruction = build_liquid_unstake_instruction(
            self.marinade_state.key(),
            self.msol_mint.key(),
            self.liq_pool_sol_leg_pda.key(),
            self.liq_pool_msol_leg.key(),
            self.treasury_msol_account.key(),
            self.vault_msol_token_account.key(),
            vault.key(),
            user.key(),
            self.system_program.key(),
            self.token_program.key(),
            msol_amount,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &unstake_instruction,
            &[
                self.marinade_state.to_account_info(),
                self.msol_mint.to_account_info(),
                self.liq_pool_sol_leg_pda.to_account_info(),
                self.liq_pool_msol_leg.to_account_info(),
                self.treasury_msol_account.to_account_info(),
                self.vault_msol_token_account.to_account_info(),
                vault.to_account_info(),
                user.to_account_info(),
                self.system_program.to_account_info(),
                self.token_program.to_account_info(),
                self.marinade_program.to_account_info(),
            ],
            vault_signer_seeds,
        )?;

        Ok(())
    }
}
