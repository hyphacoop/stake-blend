import { PublicKey, Connection } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

/**
 * Marinade Finance Protocol Constants
 * These are the mainnet addresses cloned to the test validator
 */

export const MARINADE_PROGRAM_ID = new PublicKey(
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD'
);

export const MARINADE_STATE = new PublicKey(
  '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC'
);

export const MSOL_MINT = new PublicKey(
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
);

export const LIQ_POOL_SOL_LEG_PDA = new PublicKey(
  'UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q'
);

export const LIQ_POOL_MSOL_LEG = new PublicKey(
  '7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE'
);

export const TREASURY_MSOL_ACCOUNT = new PublicKey(
  'B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR'
);

/**
 * PDA derivation helpers for Marinade accounts
 * These PDAs are derived from the Marinade state and seeds
 */

export function findMarinadeReservePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MARINADE_STATE.toBuffer(), Buffer.from('reserve')],
    MARINADE_PROGRAM_ID
  );
}

export function findMSolMintAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MARINADE_STATE.toBuffer(), Buffer.from('st_mint')],
    MARINADE_PROGRAM_ID
  );
}

export function findLiqPoolMSolLegAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MARINADE_STATE.toBuffer(), Buffer.from('liq_st_sol_authority')],
    MARINADE_PROGRAM_ID
  );
}

// Note: treasury_msol_account is NOT a PDA, it's stored in Marinade state
// Removed findTreasuryMSolAccount() - use TREASURY_MSOL_ACCOUNT constant instead

/**
 * Get all Marinade accounts needed for operations
 * This provides a convenient way to get all accounts at once
 */
export function getMarinadeAccounts(vaultPda: PublicKey) {
  const [reservePda] = findMarinadeReservePDA();
  const [msolMintAuthority] = findMSolMintAuthority();
  const [liqPoolMSolLegAuthority] = findLiqPoolMSolLegAuthority();

  // Get vault's mSOL token account
  const vaultMSolTokenAccount = getAssociatedTokenAddressSync(
    MSOL_MINT,
    vaultPda,
    true // allowOwnerOffCurve
  );

  return {
    marinadeState: MARINADE_STATE,
    msolMint: MSOL_MINT,
    liqPoolSolLegPda: LIQ_POOL_SOL_LEG_PDA,
    liqPoolMSolLeg: LIQ_POOL_MSOL_LEG,
    liqPoolMSolLegAuthority,
    reservePda,
    msolMintAuthority,
    treasuryMSolAccount: TREASURY_MSOL_ACCOUNT,
    vaultMSolTokenAccount,
  };
}

/**
 * Marinade pool configuration for tests
 * This mimics the structure used for SPL stake pools
 */
export interface MarinadePoolConfig {
  // For vault initialization (3 accounts)
  stakePool: PublicKey; // Actually marinade_state
  poolMint: PublicKey;  // Actually msol_mint
  vaultPoolTokenAccount: PublicKey; // Vault's mSOL ATA

  // For deposits (11 accounts total)
  marinadeState: PublicKey;
  msolMint: PublicKey;
  liqPoolSolLegPda: PublicKey;
  liqPoolMSolLeg: PublicKey;
  liqPoolMSolLegAuthority: PublicKey;
  reservePda: PublicKey;
  vaultMSolTokenAccount: PublicKey;
  msolMintAuthority: PublicKey;

  // For withdrawals (10 accounts total)
  treasuryMSolAccount: PublicKey;
}

/**
 * Create a Marinade pool configuration for a given vault
 */
export function createMarinadePoolConfig(vaultPda: PublicKey): MarinadePoolConfig {
  const accounts = getMarinadeAccounts(vaultPda);

  return {
    // For initialization
    stakePool: accounts.marinadeState, // Aliased as stakePool for consistency
    poolMint: accounts.msolMint,
    vaultPoolTokenAccount: accounts.vaultMSolTokenAccount,

    // All Marinade-specific accounts
    ...accounts,
  };
}

/**
 * Helper to get mSOL price from Marinade state
 * Note: In real tests, you'd deserialize the Marinade state account
 * For now, we return a typical mSOL price value
 */
export async function getMSolPrice(
  connection: Connection,
  marinadeState: PublicKey = MARINADE_STATE
): Promise<number> {
  // TODO: Deserialize MarinadeState account and read msol_price field
  // msol_price is stored as u64 with precision of 0x1_0000_0000
  // For now, return approximate value
  return 1.05; // mSOL typically worth ~1.05 SOL
}

/**
 * Calculate SOL value from mSOL amount
 */
export function msolToSol(msolAmount: number, msolPrice: number): number {
  return msolAmount * msolPrice;
}

/**
 * Calculate mSOL amount from SOL value
 */
export function solToMSol(solAmount: number, msolPrice: number): number {
  return solAmount / msolPrice;
}
