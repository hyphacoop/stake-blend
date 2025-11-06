/**
 * Vault Query Helpers
 *
 * These functions fetch vault configuration from on-chain accounts
 * and derive all necessary accounts for interacting with the vault.
 */

import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { StakePoolLayout } from '@solana/spl-stake-pool';
import { getPDAs, findWithdrawAuthority, STAKE_POOL_PROGRAM } from './vault-helpers-shared';

// Re-export shared utilities
export { getPDAs, findWithdrawAuthority, STAKE_POOL_PROGRAM };

export interface VaultData {
  vaultId: number;
  stakePools: PublicKey[];
  poolMints: PublicKey[];
  allocations: number[];
  totalSharesIssued: anchor.BN;
  bump: number;
}

export interface PoolAccounts {
  stakePool: PublicKey;
  poolMint: PublicKey;
  reserve: PublicKey;
  withdrawAuthority: PublicKey;
  managerFee: PublicKey;
  vaultPoolTokenAccount: PublicKey;
}


/**
 * Fetch vault account data from on-chain
 */
export async function fetchVaultData(
  program: anchor.Program,
  vaultId: number
): Promise<VaultData> {
  const { vaultPda } = getPDAs(program.programId, vaultId);
  const vault = await program.account.vault.fetch(vaultPda);

  return {
    vaultId: vault.vaultId,
    stakePools: vault.stakePools,
    poolMints: vault.poolMints,
    allocations: vault.allocations,
    totalSharesIssued: vault.totalSharesIssued,
    bump: vault.bump,
  };
}

/**
 * Query stake pool account and derive all related accounts
 */
export async function fetchPoolAccounts(
  connection: Connection,
  stakePool: PublicKey,
  poolMint: PublicKey,
  vaultPda: PublicKey
): Promise<PoolAccounts> {
  // Fetch stake pool account
  const stakePoolAccount = await connection.getAccountInfo(stakePool);
  if (!stakePoolAccount) {
    throw new Error(`Stake pool account not found: ${stakePool.toString()}`);
  }

  // Decode stake pool data
  const stakePoolData = StakePoolLayout.decode(stakePoolAccount.data);

  const reserve = new PublicKey(stakePoolData.reserveStake);
  const managerFee = new PublicKey(stakePoolData.managerFeeAccount);

  // Derive withdraw authority PDA
  const withdrawAuthority = findWithdrawAuthority(stakePool);

  // Calculate vault's ATA for this pool mint
  const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
    poolMint,
    vaultPda,
    true // allowOwnerOffCurve
  );

  return {
    stakePool,
    poolMint,
    reserve,
    withdrawAuthority,
    managerFee,
    vaultPoolTokenAccount,
  };
}

/**
 * Fetch all pool accounts for a vault
 */
export async function fetchAllPoolAccounts(
  connection: Connection,
  program: anchor.Program,
  vaultId: number
): Promise<PoolAccounts[]> {
  const vaultData = await fetchVaultData(program, vaultId);
  const { vaultPda } = getPDAs(program.programId, vaultId);

  const poolAccounts: PoolAccounts[] = [];

  for (let i = 0; i < vaultData.stakePools.length; i++) {
    const accounts = await fetchPoolAccounts(
      connection,
      vaultData.stakePools[i],
      vaultData.poolMints[i],
      vaultPda
    );
    poolAccounts.push(accounts);
  }

  return poolAccounts;
}

/**
 * Build remaining accounts for deposit instruction (7 accounts per pool)
 */
export function buildDepositRemainingAccounts(poolAccounts: PoolAccounts[]) {
  const remainingAccounts = [];

  for (const pool of poolAccounts) {
    remainingAccounts.push(
      { pubkey: pool.stakePool, isSigner: false, isWritable: true },
      { pubkey: pool.withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: pool.reserve, isSigner: false, isWritable: true },
      { pubkey: pool.poolMint, isSigner: false, isWritable: true },
      { pubkey: pool.vaultPoolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: pool.managerFee, isSigner: false, isWritable: true },
      { pubkey: pool.managerFee, isSigner: false, isWritable: true } // referrer fee (using manager as default)
    );
  }

  return remainingAccounts;
}

/**
 * Build remaining accounts for withdraw instruction (6 accounts per pool)
 */
export function buildWithdrawRemainingAccounts(poolAccounts: PoolAccounts[]) {
  const remainingAccounts = [];

  for (const pool of poolAccounts) {
    remainingAccounts.push(
      { pubkey: pool.stakePool, isSigner: false, isWritable: true },
      { pubkey: pool.withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: pool.reserve, isSigner: false, isWritable: true },
      { pubkey: pool.poolMint, isSigner: false, isWritable: true },
      { pubkey: pool.vaultPoolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: pool.managerFee, isSigner: false, isWritable: true }
    );
  }

  return remainingAccounts;
}

/**
 * Calculate vault's total value in SOL by querying all pool token balances
 */
export async function calculateVaultValue(
  connection: Connection,
  poolAccounts: PoolAccounts[]
): Promise<number> {
  let totalValue = 0;

  for (const pool of poolAccounts) {
    // Get vault's pool token balance
    const tokenBalance = await connection.getTokenAccountBalance(
      pool.vaultPoolTokenAccount
    );
    const tokenAmount = BigInt(tokenBalance.value.amount);

    // Get stake pool data to calculate exchange rate
    const stakePoolAccount = await connection.getAccountInfo(pool.stakePool);
    if (!stakePoolAccount) continue;

    const stakePoolData = StakePoolLayout.decode(stakePoolAccount.data);
    const totalLamports = BigInt(stakePoolData.totalLamports.toString());
    const poolTokenSupply = BigInt(stakePoolData.poolTokenSupply.toString());

    // Calculate SOL value
    if (poolTokenSupply > 0n) {
      const solValue = Number((tokenAmount * totalLamports) / poolTokenSupply);
      totalValue += solValue;
    }
  }

  return totalValue / 1e9; // Convert lamports to SOL
}

/**
 * Calculate the current share price of the vault
 */
export async function calculateSharePrice(
  connection: Connection,
  program: anchor.Program,
  vaultId: number
): Promise<number> {
  const vaultData = await fetchVaultData(program, vaultId);
  const poolAccounts = await fetchAllPoolAccounts(connection, program, vaultId);

  const totalValue = await calculateVaultValue(connection, poolAccounts);
  const totalShares = Number(vaultData.totalSharesIssued) / 1e9;

  if (totalShares === 0) return 1; // Initial share price

  return totalValue / totalShares;
}
