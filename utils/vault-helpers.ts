/**
 * Shared Vault Helper Utilities
 *
 * This file is copied to web/src/lib/ via npm run update-idl
 * DO NOT EDIT the copy in web/ - edit this file instead!
 */

import { PublicKey } from '@solana/web3.js';

export const STAKE_POOL_PROGRAM = new PublicKey(
  'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'
);

/**
 * Derive vault and mint PDAs from vault ID
 */
export function getPDAs(programId: PublicKey, vaultId: number) {
  const vaultIdBuffer = Buffer.alloc(8);
  vaultIdBuffer.writeBigUInt64LE(BigInt(vaultId));

  const [mintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('mint'), vaultIdBuffer],
    programId
  );

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), vaultIdBuffer],
    programId
  );

  return { mintPda, vaultPda };
}

/**
 * Derive withdraw authority PDA for a stake pool
 * Uses the same derivation as spl_stake_pool::find_withdraw_authority_program_address
 * Seeds: [stake_pool_address, "withdraw"]
 */
export function findWithdrawAuthority(stakePoolAddress: PublicKey): PublicKey {
  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [stakePoolAddress.toBuffer(), Buffer.from('withdraw')],
    STAKE_POOL_PROGRAM
  );
  return withdrawAuthority;
}
