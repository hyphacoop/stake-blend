import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

/**
 * Common test fixtures and setup utilities
 */

export const pools = [
  {
    stakePool: new anchor.web3.PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi"),
    poolMint: new anchor.web3.PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"),
    reserve: new anchor.web3.PublicKey("rsrxDvYUXjH1RQj2Ke36LNZEVqGztATxFkqNukERqFT"),
    withdrawAuthority: new anchor.web3.PublicKey("6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2"),
    managerFee: new anchor.web3.PublicKey("Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1"),
  },
  {
    stakePool: new anchor.web3.PublicKey("SAVEY1fVMBeRVo9V9rgEz8ENTvHreftd3QgpAKBDFV4"),
    poolMint: new anchor.web3.PublicKey("SAVEDpx3nFNdzG3ymJfShYnrBuYy7LtQEABZQ3qtTFt"),
    reserve: new anchor.web3.PublicKey("FL2AsvZPTW33QdmBgQx15ZdtaSbmuwY3oBCJMj63u9W1"),
    withdrawAuthority: new anchor.web3.PublicKey("9yWcz4S27nXKpsVmWqaimphCUnFo441JUvwkzmvRWys3"),
    managerFee: new anchor.web3.PublicKey("5VyLWq6nGg8mkAsHUwn6KqnaTni6hFZHb6dGiV7dCtGz"),
  },
];

export const expectedAllocations = [70_00, 30_00];

export const STAKE_POOL_PROGRAM = new anchor.web3.PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");

export function getPDAs(programId: anchor.web3.PublicKey) {
  const [mintPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint")],
    programId
  );

  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    programId
  );

  return { mintPda, vaultPda };
}

/**
 * Initialize vault if it doesn't exist
 */
export async function ensureVaultInitialized(
  program: Program<StakeBlend>,
  provider: anchor.AnchorProvider
) {
  const { mintPda, vaultPda } = getPDAs(program.programId);

  try {
    await program.account.vault.fetch(vaultPda);
    console.log("✓ Vault already initialized");
    return;
  } catch (error) {
    console.log("Initializing vault...");
  }

  const remainingAccounts = [];
  for (let i = 0; i < pools.length; i++) {
    const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
      pools[i].poolMint,
      vaultPda,
      true
    );

    remainingAccounts.push(
      { pubkey: pools[i].stakePool, isSigner: false, isWritable: false },
      { pubkey: pools[i].poolMint, isSigner: false, isWritable: false },
      { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true }
    );
  }

  await program.methods
    .initialize(expectedAllocations)
    .accounts({
      mint: mintPda,
      vault: vaultPda,
      signer: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .rpc();

  console.log("✓ Vault initialized");
}

/**
 * Create user token account if it doesn't exist
 */
export async function ensureUserAccountCreated(
  program: Program<StakeBlend>,
  provider: anchor.AnchorProvider
) {
  const { mintPda } = getPDAs(program.programId);
  const userTokenAccount = getAssociatedTokenAddressSync(
    mintPda,
    provider.wallet.publicKey
  );

  try {
    await provider.connection.getTokenAccountBalance(userTokenAccount);
    console.log("✓ User token account exists");
    return;
  } catch (error) {
    console.log("Creating user token account...");
  }

  await program.methods
    .createUserAccount()
    .accounts({
      tokenAccount: userTokenAccount,
      signer: provider.wallet.publicKey,
      mint: mintPda,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    })
    .rpc();

  console.log("✓ User token account created");
}

/**
 * Complete test setup - ensures vault and user account exist
 */
export async function setupTests(
  program: Program<StakeBlend>,
  provider: anchor.AnchorProvider
) {
  await ensureVaultInitialized(program, provider);
  await ensureUserAccountCreated(program, provider);
}
