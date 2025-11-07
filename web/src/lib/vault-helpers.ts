/**
 * Vault Query Helpers
 *
 * These functions fetch vault configuration from on-chain accounts
 * and derive all necessary accounts for interacting with the vault.
 *
 * Supports both SPL Stake Pool and Marinade protocols.
 */

import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { StakePoolLayout } from '@solana/spl-stake-pool';
import { getPDAs, findWithdrawAuthority, STAKE_POOL_PROGRAM } from './vault-helpers-shared';
import { getMarinadeAccounts, MARINADE_PROGRAM_ID } from './marinade-helpers';

// Re-export shared utilities
export { getPDAs, findWithdrawAuthority, STAKE_POOL_PROGRAM };

// Protocol enum (matches on-chain PoolProtocol)
export enum PoolProtocol {
  SplStakePool = 0,
  Marinade = 1,
}

export interface VaultData {
  vaultId: number;
  stakePools: PublicKey[];
  poolMints: PublicKey[];
  allocations: number[];
  poolProtocols: PoolProtocol[];
  marinadeStates: (PublicKey | null)[];
  totalSharesIssued: anchor.BN;
  bump: number;
}

export interface PoolAccounts {
  protocol: PoolProtocol;
  stakePool: PublicKey;
  poolMint: PublicKey;
  vaultPoolTokenAccount: PublicKey;

  // SPL Stake Pool specific (optional)
  reserve?: PublicKey;
  withdrawAuthority?: PublicKey;
  managerFee?: PublicKey;

  // Marinade specific (optional)
  marinadeState?: PublicKey;
  msolMint?: PublicKey;
  liqPoolSolLegPda?: PublicKey;
  liqPoolMSolLeg?: PublicKey;
  liqPoolMSolLegAuthority?: PublicKey;
  reservePda?: PublicKey;
  msolMintAuthority?: PublicKey;
  treasuryMSolAccount?: PublicKey;
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

  // Convert protocol enums from on-chain format to TypeScript enum
  const poolProtocols = vault.poolProtocols.map((p: any) => {
    if ('splStakePool' in p) return PoolProtocol.SplStakePool;
    if ('marinade' in p) return PoolProtocol.Marinade;
    throw new Error(`Unknown protocol type: ${JSON.stringify(p)}`);
  });

  // Convert Option<Pubkey> to Pubkey | null
  const marinadeStates = vault.marinadeStates.map((s: any) => s || null);

  return {
    vaultId: vault.vaultId,
    stakePools: vault.stakePools,
    poolMints: vault.poolMints,
    allocations: vault.allocations,
    poolProtocols,
    marinadeStates,
    totalSharesIssued: vault.totalSharesIssued,
    bump: vault.bump,
  };
}

/**
 * Fetch SPL Stake Pool accounts
 */
async function fetchSplPoolAccounts(
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

  console.log(`[fetchSplPoolAccounts] Stake pool account:`, {
    address: stakePool.toString(),
    owner: stakePoolAccount.owner.toString(),
    dataLength: stakePoolAccount.data.length,
  });

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
    protocol: PoolProtocol.SplStakePool,
    stakePool,
    poolMint,
    reserve,
    withdrawAuthority,
    managerFee,
    vaultPoolTokenAccount,
  };
}

/**
 * Fetch Marinade pool accounts
 */
async function fetchMarinadePoolAccounts(
  marinadeState: PublicKey,
  msolMint: PublicKey,
  vaultPda: PublicKey
): Promise<PoolAccounts> {
  console.log(`[fetchMarinadePoolAccounts] Marinade state:`, {
    address: marinadeState.toString(),
    msolMint: msolMint.toString(),
  });

  // Get all Marinade accounts via PDA derivation
  const accounts = getMarinadeAccounts(vaultPda);

  return {
    protocol: PoolProtocol.Marinade,
    stakePool: marinadeState,
    poolMint: msolMint,
    vaultPoolTokenAccount: accounts.vaultMSolTokenAccount,

    // Marinade-specific accounts
    marinadeState: accounts.marinadeState,
    msolMint: accounts.msolMint,
    liqPoolSolLegPda: accounts.liqPoolSolLegPda,
    liqPoolMSolLeg: accounts.liqPoolMSolLeg,
    liqPoolMSolLegAuthority: accounts.liqPoolMSolLegAuthority,
    reservePda: accounts.reservePda,
    msolMintAuthority: accounts.msolMintAuthority,
    treasuryMSolAccount: accounts.treasuryMSolAccount,
  };
}

/**
 * Query pool account and derive all related accounts (protocol-aware)
 */
export async function fetchPoolAccounts(
  connection: Connection,
  protocol: PoolProtocol,
  stakePool: PublicKey,
  poolMint: PublicKey,
  marinadeState: PublicKey | null,
  vaultPda: PublicKey
): Promise<PoolAccounts> {
  if (protocol === PoolProtocol.Marinade) {
    if (!marinadeState) {
      throw new Error('Marinade state required for Marinade protocol');
    }
    return await fetchMarinadePoolAccounts(marinadeState, poolMint, vaultPda);
  } else {
    return await fetchSplPoolAccounts(connection, stakePool, poolMint, vaultPda);
  }
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

  console.log(`[fetchAllPoolAccounts] Vault data:`, {
    vaultId: vaultData.vaultId,
    numPools: vaultData.stakePools.length,
    stakePools: vaultData.stakePools.map(p => p.toString()),
    poolMints: vaultData.poolMints.map(p => p.toString()),
    poolProtocols: vaultData.poolProtocols,
  });

  const poolAccounts: PoolAccounts[] = [];

  for (let i = 0; i < vaultData.stakePools.length; i++) {
    const protocol = vaultData.poolProtocols[i];
    const protocolName = protocol === PoolProtocol.SplStakePool ? 'SPL' : 'Marinade';
    console.log(`[fetchAllPoolAccounts] Fetching pool ${i} (${protocolName}): ${vaultData.stakePools[i].toString()}`);

    const accounts = await fetchPoolAccounts(
      connection,
      protocol,
      vaultData.stakePools[i],
      vaultData.poolMints[i],
      vaultData.marinadeStates[i],
      vaultPda
    );
    poolAccounts.push(accounts);
  }

  return poolAccounts;
}

/**
 * Build remaining accounts for deposit instruction
 * SPL: 7 accounts per pool
 * Marinade: 11 accounts per pool
 */
export function buildDepositRemainingAccounts(poolAccounts: PoolAccounts[]) {
  const remainingAccounts = [];

  for (const pool of poolAccounts) {
    if (pool.protocol === PoolProtocol.SplStakePool) {
      // SPL Stake Pool: 7 accounts
      remainingAccounts.push(
        { pubkey: pool.stakePool, isSigner: false, isWritable: true },
        { pubkey: pool.withdrawAuthority!, isSigner: false, isWritable: false },
        { pubkey: pool.reserve!, isSigner: false, isWritable: true },
        { pubkey: pool.poolMint, isSigner: false, isWritable: true },
        { pubkey: pool.vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pool.managerFee!, isSigner: false, isWritable: true },
        { pubkey: pool.managerFee!, isSigner: false, isWritable: true } // referrer fee
      );
    } else if (pool.protocol === PoolProtocol.Marinade) {
      // Marinade: 11 accounts
      const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

      remainingAccounts.push(
        { pubkey: pool.marinadeState!, isSigner: false, isWritable: true },
        { pubkey: pool.msolMint!, isSigner: false, isWritable: true },
        { pubkey: pool.liqPoolSolLegPda!, isSigner: false, isWritable: true },
        { pubkey: pool.liqPoolMSolLeg!, isSigner: false, isWritable: true },
        { pubkey: pool.liqPoolMSolLegAuthority!, isSigner: false, isWritable: false },
        { pubkey: pool.reservePda!, isSigner: false, isWritable: true },
        { pubkey: pool.vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pool.msolMintAuthority!, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: MARINADE_PROGRAM_ID, isSigner: false, isWritable: false }
      );
    }
  }

  return remainingAccounts;
}

/**
 * Build remaining accounts for withdraw instruction
 * SPL: 6 accounts per pool
 * Marinade: 9 accounts per pool
 */
export function buildWithdrawRemainingAccounts(poolAccounts: PoolAccounts[]) {
  const remainingAccounts = [];

  for (const pool of poolAccounts) {
    if (pool.protocol === PoolProtocol.SplStakePool) {
      // SPL Stake Pool: 6 accounts
      remainingAccounts.push(
        { pubkey: pool.stakePool, isSigner: false, isWritable: true },
        { pubkey: pool.withdrawAuthority!, isSigner: false, isWritable: false },
        { pubkey: pool.reserve!, isSigner: false, isWritable: true },
        { pubkey: pool.poolMint, isSigner: false, isWritable: true },
        { pubkey: pool.vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pool.managerFee!, isSigner: false, isWritable: true }
      );
    } else if (pool.protocol === PoolProtocol.Marinade) {
      // Marinade: 9 accounts
      const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

      remainingAccounts.push(
        { pubkey: pool.marinadeState!, isSigner: false, isWritable: true },
        { pubkey: pool.msolMint!, isSigner: false, isWritable: true },
        { pubkey: pool.liqPoolSolLegPda!, isSigner: false, isWritable: true },
        { pubkey: pool.liqPoolMSolLeg!, isSigner: false, isWritable: true },
        { pubkey: pool.treasuryMSolAccount!, isSigner: false, isWritable: true },
        { pubkey: pool.vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: MARINADE_PROGRAM_ID, isSigner: false, isWritable: false }
      );
    }
  }

  return remainingAccounts;
}

/**
 * Calculate vault's total value in SOL by querying all pool token balances
 * Handles both SPL Stake Pool and Marinade protocols
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

    if (tokenAmount === 0n) continue;

    if (pool.protocol === PoolProtocol.SplStakePool) {
      // SPL Stake Pool: Calculate value from pool data
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
    } else if (pool.protocol === PoolProtocol.Marinade) {
      // Marinade: Use mSOL price from Marinade state
      // For now, use a simplified approach: 1 mSOL ≈ 1 SOL
      // TODO: Deserialize Marinade state to get exact msol_price
      // msol_price is stored as: SOL per mSOL * 0x1_0000_0000
      // For production, fetch and deserialize MarinadeState.msol_price
      const solValue = Number(tokenAmount); // Approximate: 1:1 ratio
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
