#!/usr/bin/env ts-node
/**
 * Vault Creation Script
 *
 * This script creates a new stake-blend vault on Solana.
 * It accepts a vault ID, stake pool addresses, and allocations,
 * then queries on-chain data to derive all required accounts.
 *
 * Usage:
 *   ts-node scripts/create-vault.ts <vault_id> <pool1,pool2,...> <alloc1,alloc2,...>
 *
 * Example:
 *   ts-node scripts/create-vault.ts 1 \
 *     "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb,stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi" \
 *     "5000,5000"
 *
 * Environment Variables:
 *   ANCHOR_WALLET - Path to keypair file (default: ~/.config/solana/id.json)
 *   ANCHOR_PROVIDER_URL - RPC endpoint (default: http://127.0.0.1:8899)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { StakePoolLayout } from "@solana/spl-stake-pool";
import * as fs from "fs";
import * as path from "path";
import { getPDAs, findWithdrawAuthority, STAKE_POOL_PROGRAM } from "../utils/vault-helpers";

interface PoolConfig {
  stakePool: PublicKey;
  poolMint: PublicKey;
  reserve: PublicKey;
  withdrawAuthority: PublicKey;
  managerFee: PublicKey;
  vaultPoolTokenAccount: PublicKey;
}


/**
 * Query stake pool account and derive all required accounts
 */
async function fetchPoolConfig(
  connection: anchor.web3.Connection,
  stakePoolAddress: PublicKey,
  vaultPda: PublicKey
): Promise<PoolConfig> {
  console.log(`\nQuerying stake pool: ${stakePoolAddress.toString()}`);

  // Fetch stake pool account
  const stakePoolAccount = await connection.getAccountInfo(stakePoolAddress);
  if (!stakePoolAccount) {
    throw new Error(`Stake pool account not found: ${stakePoolAddress}`);
  }

  // Decode stake pool data
  const stakePool = StakePoolLayout.decode(stakePoolAccount.data);

  const poolMint = new PublicKey(stakePool.poolMint);
  const reserve = new PublicKey(stakePool.reserveStake);
  const managerFee = new PublicKey(stakePool.managerFeeAccount);

  console.log(`  Pool mint: ${poolMint.toString()}`);
  console.log(`  Reserve: ${reserve.toString()}`);
  console.log(`  Manager fee: ${managerFee.toString()}`);

  // Derive withdraw authority PDA
  const withdrawAuthority = findWithdrawAuthority(stakePoolAddress);

  console.log(`  Withdraw authority (derived): ${withdrawAuthority.toString()}`);

  // Calculate vault's ATA for this pool mint
  const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
    poolMint,
    vaultPda,
    true // allowOwnerOffCurve
  );

  console.log(`  Vault pool token account: ${vaultPoolTokenAccount.toString()}`);

  return {
    stakePool: stakePoolAddress,
    poolMint,
    reserve,
    withdrawAuthority,
    managerFee,
    vaultPoolTokenAccount,
  };
}

/**
 * Main script execution
 */
async function main() {
  // Parse command line arguments
  if (process.argv.length < 5) {
    console.error("Usage: ts-node create-vault.ts <vault_id> <pool1,pool2,...> <alloc1,alloc2,...>");
    console.error("\nExample:");
    console.error('  ts-node create-vault.ts 1 "Jito...,stk9..." "5000,5000"');
    process.exit(1);
  }

  const vaultId = parseInt(process.argv[2]);
  const poolAddresses = process.argv[3].split(",").map((addr) => new PublicKey(addr.trim()));
  const allocations = process.argv[4].split(",").map((a) => parseInt(a.trim()));

  console.log("=".repeat(80));
  console.log("VAULT CREATION SCRIPT");
  console.log("=".repeat(80));
  console.log(`Vault ID: ${vaultId}`);
  console.log(`Stake pools: ${poolAddresses.length}`);
  console.log(`Allocations: ${allocations.join(", ")} (basis points)`);

  // Validate allocations
  const totalAllocation = allocations.reduce((sum, a) => sum + a, 0);
  if (totalAllocation !== 10000) {
    throw new Error(
      `Allocations must sum to 10000 (100%). Got: ${totalAllocation}`
    );
  }

  if (poolAddresses.length !== allocations.length) {
    throw new Error(
      `Number of pools (${poolAddresses.length}) must match number of allocations (${allocations.length})`
    );
  }

  // Setup Anchor provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  console.log(`\nUsing RPC: ${provider.connection.rpcEndpoint}`);
  console.log(`Using wallet: ${provider.wallet.publicKey.toString()}`);

  // Load program
  const idlPath = path.join(__dirname, "..", "target", "idl", "stake_blend.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = new PublicKey(idl.address);
  const program = new Program(idl, provider);

  console.log(`\nProgram ID: ${programId.toString()}`);

  // Derive PDAs
  const { mintPda, vaultPda } = getPDAs(programId, vaultId);

  console.log(`\nVault PDA: ${vaultPda.toString()}`);
  console.log(`Mint PDA: ${mintPda.toString()}`);

  // Check if vault already exists
  try {
    const existingVault = await (program as any).account.vault.fetch(vaultPda);
    console.error(`\n❌ ERROR: Vault ${vaultId} already exists!`);
    console.error(`Existing vault data:`, existingVault);
    process.exit(1);
  } catch (e) {
    // Vault doesn't exist, which is what we want
    console.log(`\n✅ Vault ${vaultId} does not exist yet. Proceeding...`);
  }

  // Query all stake pools and derive accounts
  console.log("\n" + "=".repeat(80));
  console.log("QUERYING STAKE POOLS");
  console.log("=".repeat(80));

  const poolConfigs: PoolConfig[] = [];
  for (const poolAddress of poolAddresses) {
    const config = await fetchPoolConfig(
      provider.connection,
      poolAddress,
      vaultPda
    );
    poolConfigs.push(config);
  }

  // Build remaining accounts array (triplets for initialize)
  const remainingAccounts = [];
  for (const config of poolConfigs) {
    remainingAccounts.push(
      { pubkey: config.stakePool, isWritable: false, isSigner: false },
      { pubkey: config.poolMint, isWritable: false, isSigner: false },
      { pubkey: config.vaultPoolTokenAccount, isWritable: true, isSigner: false }
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("INITIALIZING VAULT");
  console.log("=".repeat(80));

  console.log(`\nSending transaction...`);

  try {
    const tx = await program.methods
      .initialize(new anchor.BN(vaultId), allocations)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        signer: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log(`\n✅ SUCCESS!`);
    console.log(`Transaction signature: ${tx}`);

    // Fetch and display created vault
    const vault = await (program as any).account.vault.fetch(vaultPda);

    console.log("\n" + "=".repeat(80));
    console.log("CREATED VAULT");
    console.log("=".repeat(80));
    console.log(`Vault ID: ${vault.vaultId}`);
    console.log(`Vault PDA: ${vaultPda.toString()}`);
    console.log(`Mint PDA: ${mintPda.toString()}`);
    console.log(`Total shares issued: ${vault.totalSharesIssued}`);
    console.log(`\nStake pools (${vault.stakePools.length}):`);
    vault.stakePools.forEach((pool: PublicKey, i: number) => {
      console.log(`  ${i}: ${pool.toString()}`);
    });
    console.log(`\nPool mints (${vault.poolMints.length}):`);
    vault.poolMints.forEach((mint: PublicKey, i: number) => {
      console.log(`  ${i}: ${mint.toString()}`);
    });
    console.log(`\nAllocations (${vault.allocations.length}):`);
    vault.allocations.forEach((alloc: number, i: number) => {
      console.log(`  ${i}: ${alloc} (${(alloc / 100).toFixed(2)}%)`);
    });

    console.log("\n" + "=".repeat(80));
    console.log("NEXT STEPS");
    console.log("=".repeat(80));
    console.log("1. Update your frontend to use vault ID:", vaultId);
    console.log("2. Frontend should query vault PDA to get pool configuration");
    console.log("3. No need to hardcode pool addresses anymore!");

  } catch (error) {
    console.error("\n❌ TRANSACTION FAILED");
    console.error(error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
