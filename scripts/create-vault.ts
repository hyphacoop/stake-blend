#!/usr/bin/env ts-node
/**
 * Vault Creation Script
 *
 * This script creates a new stake-blend vault on Solana.
 * Supports both SPL Stake Pool and Marinade Finance protocols.
 *
 * Usage:
 *   ts-node scripts/create-vault.ts <vault_id> <protocols> <pools> <allocations>
 *
 * Protocols: Comma-separated list of "spl" or "marinade"
 * Pools: Comma-separated stake pool addresses (or "marinade" for Marinade)
 * Allocations: Comma-separated basis points (must sum to 10000)
 *
 * Examples:
 *   # SPL-only vault (JitoSOL + bSOL, 50/50)
 *   ts-node scripts/create-vault.ts 1 \
 *     "spl,spl" \
 *     "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb,stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi" \
 *     "5000,5000"
 *
 *   # Mixed vault (bSOL + Marinade + JitoSOL, 33/33/33)
 *   ts-node scripts/create-vault.ts 2 \
 *     "spl,marinade,spl" \
 *     "stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi,marinade,Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb" \
 *     "3333,3334,3333"
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
import { getPDAs, findWithdrawAuthority } from "../utils/vault-helpers";

// Marinade constants (exported for testing)
export const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
export const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");

export enum PoolProtocol {
  SplStakePool = "spl",
  Marinade = "marinade",
}

export interface PoolConfig {
  protocol: PoolProtocol;
  stakePool: PublicKey;
  poolMint: PublicKey;
  vaultPoolTokenAccount: PublicKey;
  marinadeState?: PublicKey;
  // SPL-specific
  reserve?: PublicKey;
  withdrawAuthority?: PublicKey;
  managerFee?: PublicKey;
}

/**
 * Query SPL stake pool account and derive all required accounts
 * Exported for testing
 */
export async function fetchSplPoolConfig(
  connection: anchor.web3.Connection,
  stakePoolAddress: PublicKey,
  vaultPda: PublicKey
): Promise<PoolConfig> {
  console.log(`\n  Querying SPL stake pool: ${stakePoolAddress.toString()}`);

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

  console.log(`    Pool mint: ${poolMint.toString()}`);
  console.log(`    Reserve: ${reserve.toString()}`);
  console.log(`    Manager fee: ${managerFee.toString()}`);

  // Derive withdraw authority PDA
  const withdrawAuthority = findWithdrawAuthority(stakePoolAddress);
  console.log(`    Withdraw authority: ${withdrawAuthority.toString()}`);

  // Calculate vault's ATA for this pool mint
  const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
    poolMint,
    vaultPda,
    true // allowOwnerOffCurve
  );

  console.log(`    Vault pool token account: ${vaultPoolTokenAccount.toString()}`);

  return {
    protocol: PoolProtocol.SplStakePool,
    stakePool: stakePoolAddress,
    poolMint,
    reserve,
    withdrawAuthority,
    managerFee,
    vaultPoolTokenAccount,
  };
}

/**
 * Create Marinade pool config (uses constant addresses)
 * Exported for testing
 */
export function createMarinadePoolConfig(vaultPda: PublicKey): PoolConfig {
  console.log(`\n  Creating Marinade config`);
  console.log(`    Marinade state: ${MARINADE_STATE.toString()}`);
  console.log(`    mSOL mint: ${MSOL_MINT.toString()}`);

  const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
    MSOL_MINT,
    vaultPda,
    true
  );

  console.log(`    Vault mSOL token account: ${vaultPoolTokenAccount.toString()}`);

  return {
    protocol: PoolProtocol.Marinade,
    stakePool: MARINADE_STATE,
    poolMint: MSOL_MINT,
    vaultPoolTokenAccount,
    marinadeState: MARINADE_STATE,
  };
}

/**
 * Main script execution
 */
async function main() {
  // Parse command line arguments
  if (process.argv.length < 6) {
    console.error("Usage: ts-node create-vault.ts <vault_id> <protocols> <pools> <allocations>");
    console.error("\nProtocols: Comma-separated 'spl' or 'marinade'");
    console.error("Pools: Comma-separated addresses (use 'marinade' for Marinade)");
    console.error("Allocations: Comma-separated basis points (must sum to 10000)");
    console.error("\nExamples:");
    console.error('  # SPL-only:');
    console.error('  ts-node create-vault.ts 1 "spl,spl" "Jito...,stk9..." "5000,5000"');
    console.error('  # Mixed:');
    console.error('  ts-node create-vault.ts 2 "spl,marinade,spl" "stk9...,marinade,Jito..." "3333,3334,3333"');
    process.exit(1);
  }

  const vaultId = parseInt(process.argv[2]);
  const protocolsInput = process.argv[3].split(",").map((p) => p.trim().toLowerCase());
  const poolsInput = process.argv[4].split(",").map((p) => p.trim());
  const allocations = process.argv[5].split(",").map((a) => parseInt(a.trim()));

  console.log("=".repeat(80));
  console.log("VAULT CREATION SCRIPT");
  console.log("=".repeat(80));
  console.log(`Vault ID: ${vaultId}`);
  console.log(`Protocols: ${protocolsInput.join(", ")}`);
  console.log(`Pools: ${poolsInput.length}`);
  console.log(`Allocations: ${allocations.join(", ")} (basis points)`);

  // Validate input lengths match
  if (protocolsInput.length !== poolsInput.length || protocolsInput.length !== allocations.length) {
    throw new Error(
      `Mismatched input lengths: ${protocolsInput.length} protocols, ${poolsInput.length} pools, ${allocations.length} allocations`
    );
  }

  // Validate allocations sum to 10000
  const totalAllocation = allocations.reduce((sum, a) => sum + a, 0);
  if (totalAllocation !== 10000) {
    throw new Error(
      `Allocations must sum to 10000 (100%). Got: ${totalAllocation}`
    );
  }

  // Validate protocol values
  for (const proto of protocolsInput) {
    if (proto !== "spl" && proto !== "marinade") {
      throw new Error(`Invalid protocol: ${proto}. Must be 'spl' or 'marinade'`);
    }
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
    console.log(`\n✅ Vault ${vaultId} does not exist yet. Proceeding...`);
  }

  // Build pool configs
  console.log("\n" + "=".repeat(80));
  console.log("BUILDING POOL CONFIGURATIONS");
  console.log("=".repeat(80));

  const poolConfigs: PoolConfig[] = [];
  const poolProtocols: any[] = [];
  const marinadeStates: (PublicKey | null)[] = [];
  const stakePools: PublicKey[] = [];
  const poolMints: PublicKey[] = [];

  for (let i = 0; i < protocolsInput.length; i++) {
    const protocol = protocolsInput[i];
    const poolInput = poolsInput[i];

    console.log(`\nPool ${i}: ${protocol.toUpperCase()}`);

    let config: PoolConfig;

    if (protocol === "marinade") {
      config = createMarinadePoolConfig(vaultPda);
      poolProtocols.push({ marinade: {} });
      marinadeStates.push(MARINADE_STATE);
    } else {
      const poolAddress = new PublicKey(poolInput);
      config = await fetchSplPoolConfig(provider.connection, poolAddress, vaultPda);
      poolProtocols.push({ splStakePool: {} });
      marinadeStates.push(null);
    }

    poolConfigs.push(config);
    stakePools.push(config.stakePool);
    poolMints.push(config.poolMint);
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
  console.log(`  Vault ID: ${vaultId}`);
  console.log(`  Allocations: ${allocations.join(", ")}`);
  console.log(`  Pool protocols: ${poolProtocols.map((p, i) => protocolsInput[i]).join(", ")}`);
  console.log(`  Marinade states: ${marinadeStates.map(s => s ? s.toString().slice(0, 8) + "..." : "null").join(", ")}`);

  try {
    const tx = await program.methods
      .initialize(
        new anchor.BN(vaultId),
        allocations,
        poolProtocols,
        marinadeStates
      )
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        signer: provider.wallet.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
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
      const protocolName = 'marinade' in vault.poolProtocols[i] ? 'Marinade' : 'SPL';
      console.log(`  ${i} [${protocolName}]: ${pool.toString()}`);
    });
    console.log(`\nPool mints (${vault.poolMints.length}):`);
    vault.poolMints.forEach((mint: PublicKey, i: number) => {
      console.log(`  ${i}: ${mint.toString()}`);
    });
    console.log(`\nAllocations (${vault.allocations.length}):`);
    vault.allocations.forEach((alloc: number, i: number) => {
      console.log(`  ${i}: ${alloc} (${(alloc / 100).toFixed(2)}%)`);
    });
    console.log(`\nProtocols (${vault.poolProtocols.length}):`);
    vault.poolProtocols.forEach((proto: any, i: number) => {
      const name = 'marinade' in proto ? 'Marinade' : 'SPL Stake Pool';
      console.log(`  ${i}: ${name}`);
    });

    console.log("\n" + "=".repeat(80));
    console.log("NEXT STEPS");
    console.log("=".repeat(80));
    console.log("1. Update your frontend to use vault ID:", vaultId);
    console.log("2. Frontend should query vault PDA to get pool configuration");
    console.log("3. Use StakeBlendClient for deposits/withdrawals");
    console.log("4. Client will automatically handle protocol differences");

  } catch (error) {
    console.error("\n❌ TRANSACTION FAILED");
    console.error(error);
    process.exit(1);
  }
}

// Only run main() if this file is executed directly (not imported)
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
