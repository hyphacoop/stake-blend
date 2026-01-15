/// Raw Marinade Finance protocol interface
/// This module contains the minimal types and instruction builders needed to CPI to Marinade
/// No vault-specific logic here - just the protocol interface

use anchor_lang::prelude::*;
use anchor_lang::error::ErrorCode;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use borsh::BorshDeserialize;

/// Marinade Finance program ID (mainnet)
pub const MARINADE_PROGRAM_ID: Pubkey = pubkey!("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");

/// Anchor instruction discriminators (8 bytes)
/// These are the first 8 bytes of SHA256("global:<instruction_name>")
///
/// Note: Marinade uses snake_case in discriminators even though IDL shows camelCase
/// Calculated as:
/// - deposit: echo -n "global:deposit" | shasum -a 256
///   = f223c68952e1f2b64f7fdf8db46763fed2f53987356e679488d82c0aa642809f
/// - liquid_unstake: echo -n "global:liquid_unstake" | shasum -a 256
///   = 1e1e77f0bfe30c10215b812f0f7ada7b0ac3d96ff1842c09f75c3d603494c967

pub const DEPOSIT_DISCRIMINATOR: [u8; 8] = [0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6];
pub const LIQUID_UNSTAKE_DISCRIMINATOR: [u8; 8] = [0x1e, 0x1e, 0x77, 0xf0, 0xbf, 0xe3, 0x0c, 0x10];

/// Minimal Marinade State struct
/// We only deserialize the fields we need for price calculations
/// Full struct definition: https://github.com/marinade-finance/liquid-staking-program
#[derive(BorshDeserialize)]
pub struct MarinadeState {
    pub msol_mint: Pubkey,
    pub admin_authority: Pubkey,
    pub operational_sol_account: Pubkey,
    pub treasury_msol_account: Pubkey,
    pub reserve_bump_seed: u8,
    pub msol_mint_authority_bump_seed: u8,
    pub rent_exempt_for_token_acc: u64,
    pub reward_fee_bp: u32,
    pub liq_pool: LiqPool,
    pub available_reserve_balance: u64,
    pub msol_supply: u64,
    pub msol_price: u64, // SOL per mSOL * 0x1_0000_0000
}

#[derive(BorshDeserialize)]
pub struct LiqPool {
    pub lp_mint: Pubkey,
    pub lp_mint_authority_bump_seed: u8,
    pub sol_leg_bump_seed: u8,
    pub msol_leg_authority_bump_seed: u8,
    pub msol_leg: Pubkey,
    pub lp_liquidity_target: u64,
    pub lp_max_fee_bp: u32,
    pub lp_min_fee_bp: u32,
    pub treasury_cut_bp: u32,
    pub lp_supply: u64,
    pub lent_from_sol_leg: u64,
    pub liquidity_sol_cap: u64,
}

/// Calculate SOL value from mSOL amount using Marinade's price
pub fn msol_to_sol(msol_amount: u64, msol_price: u64) -> Result<u64> {
    let sol_value = (msol_amount as u128)
        .checked_mul(msol_price as u128)
        .ok_or(ErrorCode::InvalidNumericConversion)?
        .checked_div(0x1_0000_0000)
        .ok_or(ErrorCode::InvalidNumericConversion)? as u64;
    Ok(sol_value)
}

/// Build a Marinade deposit instruction
/// Deposits SOL and receives mSOL
pub fn build_deposit_instruction(
    marinade_state: Pubkey,
    msol_mint: Pubkey,
    liq_pool_sol_leg_pda: Pubkey,
    liq_pool_msol_leg: Pubkey,
    liq_pool_msol_leg_authority: Pubkey,
    reserve_pda: Pubkey,
    transfer_from: Pubkey,
    mint_to: Pubkey,
    msol_mint_authority: Pubkey,
    system_program: Pubkey,
    token_program: Pubkey,
    lamports: u64,
) -> Instruction {
    let accounts = vec![
        AccountMeta::new(marinade_state, false),
        AccountMeta::new(msol_mint, false),
        AccountMeta::new(liq_pool_sol_leg_pda, false),
        AccountMeta::new(liq_pool_msol_leg, false),
        AccountMeta::new_readonly(liq_pool_msol_leg_authority, false),
        AccountMeta::new(reserve_pda, false),
        AccountMeta::new(transfer_from, true),
        AccountMeta::new(mint_to, false),
        AccountMeta::new_readonly(msol_mint_authority, false),
        AccountMeta::new_readonly(system_program, false),
        AccountMeta::new_readonly(token_program, false),
    ];

    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&DEPOSIT_DISCRIMINATOR);
    data.extend_from_slice(&lamports.to_le_bytes());

    Instruction {
        program_id: MARINADE_PROGRAM_ID,
        accounts,
        data,
    }
}

/// Build a Marinade liquid unstake instruction
/// Burns mSOL and receives SOL instantly from liquidity pool
pub fn build_liquid_unstake_instruction(
    marinade_state: Pubkey,
    msol_mint: Pubkey,
    liq_pool_sol_leg_pda: Pubkey,
    liq_pool_msol_leg: Pubkey,
    treasury_msol_account: Pubkey,
    get_msol_from: Pubkey,
    get_msol_from_authority: Pubkey,
    transfer_sol_to: Pubkey,
    system_program: Pubkey,
    token_program: Pubkey,
    msol_amount: u64,
) -> Instruction {
    let accounts = vec![
        AccountMeta::new(marinade_state, false),
        AccountMeta::new(msol_mint, false),
        AccountMeta::new(liq_pool_sol_leg_pda, false),
        AccountMeta::new(liq_pool_msol_leg, false),
        AccountMeta::new(treasury_msol_account, false),
        AccountMeta::new(get_msol_from, false),
        AccountMeta::new_readonly(get_msol_from_authority, true),
        AccountMeta::new(transfer_sol_to, false),
        AccountMeta::new_readonly(system_program, false),
        AccountMeta::new_readonly(token_program, false),
    ];

    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&LIQUID_UNSTAKE_DISCRIMINATOR);
    data.extend_from_slice(&msol_amount.to_le_bytes());

    Instruction {
        program_id: MARINADE_PROGRAM_ID,
        accounts,
        data,
    }
}
