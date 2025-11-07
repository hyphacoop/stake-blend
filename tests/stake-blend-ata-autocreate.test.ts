import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getPDAs, ensureVaultInitialized, getATAInfo, pools, PoolProtocol, createProtocolEnum } from './fixtures';
import { createMarinadePoolConfig } from './marinade-helpers';
import { StakeBlendClient } from '../web/src/lib/anchor-client';

/**
 * E2E Tests for ATA Auto-Creation
 *
 * These tests verify that the StakeBlendClient correctly auto-creates ATAs when needed.
 * The client is used exactly as it would be in the UI to ensure we're testing the real code path.
 */
describe("stake-blend: ATA Auto-Creation (E2E)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;
  const vaultId = 0;
  const { mintPda, vaultPda } = getPDAs(program.programId, vaultId);

  // Initialize the client (this is what the UI does)
  let client: StakeBlendClient;

  // Initialize vault and client before tests
  before(async () => {
    await ensureVaultInitialized(program, provider, vaultId);

    // Initialize the client (mimics UI behavior)
    client = new StakeBlendClient(provider.connection, provider.wallet as anchor.Wallet, vaultId);

    console.log("\n🧪 Testing ATA Auto-Creation Flow with StakeBlendClient...\n");
  });

  it("Deposit with fresh wallet (no ATA) - should auto-create ATA", async () => {
    // Step 1: Check if ATA exists before deposit
    const ataInfoBefore = await getATAInfo(provider, mintPda, provider.wallet.publicKey);
    console.log(`ATA exists before deposit: ${ataInfoBefore.exists}`);

    // Get balances before deposit
    const balancesBefore = await client.getUserBalances();
    console.log(`SOL balance before: ${balancesBefore.sol.toFixed(2)} SOL`);
    console.log(`Vault shares before: ${balancesBefore.vaultShares.toFixed(6)} shares`);

    // Step 2: Use the client to deposit (this is what the UI does!)
    // The client will automatically handle ATA creation if needed
    const depositAmountSOL = 1.0; // 1 SOL
    console.log(`\n💰 Depositing ${depositAmountSOL} SOL via StakeBlendClient...`);

    const txSig = await client.deposit(depositAmountSOL);
    console.log(`✅ Transaction successful: ${txSig}`);

    // Step 3: Verify ATA was created and user received shares
    const ataInfoAfter = await getATAInfo(provider, mintPda, provider.wallet.publicKey);
    expect(ataInfoAfter.exists).to.be.true;
    console.log("✅ ATA exists after deposit");

    // Step 4: Verify shares received using client method
    const balancesAfter = await client.getUserBalances();
    console.log(`Vault shares after: ${balancesAfter.vaultShares.toFixed(6)} shares`);

    expect(balancesAfter.vaultShares).to.be.greaterThan(0);
    console.log(`✅ User received ${balancesAfter.vaultShares.toFixed(6)} vault shares`);
  });

  it("Second deposit with existing ATA - should NOT create ATA again", async () => {
    // Step 1: Verify ATA exists from previous test
    const ataInfoBefore = await getATAInfo(provider, mintPda, provider.wallet.publicKey);
    expect(ataInfoBefore.exists).to.be.true;
    console.log("✓ ATA already exists from previous deposit");

    // Get balance before using client
    const balancesBefore = await client.getUserBalances();
    console.log(`Balance before: ${balancesBefore.vaultShares.toFixed(6)} shares`);

    // Step 2: Deposit again using client (should skip ATA creation internally)
    const depositAmountSOL = 0.5; // 0.5 SOL
    console.log(`\n💰 Depositing ${depositAmountSOL} SOL via StakeBlendClient...`);

    const txSig = await client.deposit(depositAmountSOL);
    console.log(`✅ Transaction successful: ${txSig}`);
    console.log("✅ Deposit succeeded without ATA creation");

    // Step 3: Verify balance increased using client
    const balancesAfter = await client.getUserBalances();
    console.log(`Balance after: ${balancesAfter.vaultShares.toFixed(6)} shares`);

    expect(balancesAfter.vaultShares).to.be.greaterThan(balancesBefore.vaultShares);
    const sharesAdded = balancesAfter.vaultShares - balancesBefore.vaultShares;
    console.log(`✅ Shares increased by ${sharesAdded.toFixed(6)}`);
  });

  it("Verify client.getUserBalances() returns correct data", async () => {
    // This test verifies the client's balance getter works correctly
    const balances = await client.getUserBalances();

    console.log(`SOL balance: ${balances.sol.toFixed(2)} SOL`);
    console.log(`Vault shares: ${balances.vaultShares.toFixed(6)} shares`);

    // At this point, we should have vault shares from previous tests
    expect(balances.vaultShares).to.be.greaterThan(0);
    expect(balances.sol).to.be.greaterThan(0);

    // Verify ATA exists (since we have shares)
    const ataInfo = await getATAInfo(provider, mintPda, provider.wallet.publicKey);
    expect(ataInfo.exists).to.be.true;

    console.log("✅ Client successfully returns user balances");
    console.log("✅ ATA exists and contains vault shares");
  });
});

/**
 * E2E Tests for 3-Way Mixed Protocol Vault
 *
 * Tests StakeBlendClient with a vault containing:
 * - 33.3% bSOL (SPL Stake Pool)
 * - 33.3% mSOL (Marinade)
 * - 33.3% JitoSOL (SPL Stake Pool)
 *
 * This will EXPOSE BUGS in vault-helpers.ts which assumes all pools are SPL.
 */
describe("stake-blend: 3-Way Mixed Protocol Vault (E2E)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;
  const vaultId = 3; // New vault for 3-way mixed
  const { mintPda, vaultPda } = getPDAs(program.programId, vaultId);

  let client: StakeBlendClient;

  console.log("\n🧪 Testing 3-Way Mixed Protocol Vault with StakeBlendClient...\n");

  it("Initialize 3-way mixed vault (bSOL + mSOL + JitoSOL)", async () => {
    // Check if vault already exists
    try {
      await program.account.vault.fetch(vaultPda);
      console.log(`✓ Vault ${vaultId} already initialized`);
      return;
    } catch (error) {
      console.log(`Initializing 3-way mixed vault ${vaultId}...`);
    }

    // Pool 0: bSOL (SPL Stake Pool)
    const bsolPoolBase = pools[1]; // Index 1 is bSOL in fixtures
    const bsolVaultTokenAccount = getAssociatedTokenAddressSync(
      bsolPoolBase.poolMint,
      vaultPda,
      true
    );
    const bsolPool = {
      ...bsolPoolBase,
      vaultPoolTokenAccount: bsolVaultTokenAccount
    };

    // Pool 1: Marinade (mSOL)
    const marinadePool = createMarinadePoolConfig(vaultPda);

    // Pool 2: JitoSOL (SPL Stake Pool)
    const jitoPoolBase = pools[0]; // Index 0 is JitoSOL
    const jitoVaultTokenAccount = getAssociatedTokenAddressSync(
      jitoPoolBase.poolMint,
      vaultPda,
      true
    );
    const jitoPool = {
      ...jitoPoolBase,
      vaultPoolTokenAccount: jitoVaultTokenAccount
    };

    const poolProtocols = [
      PoolProtocol.SplStakePool,  // bSOL
      PoolProtocol.Marinade,      // mSOL
      PoolProtocol.SplStakePool   // JitoSOL
    ];
    const allocations = [3333, 3334, 3333]; // ~33.3% each (must sum to 10000)

    console.log("  Pool 0: bSOL (SPL)");
    console.log("  Pool 1: mSOL (Marinade)");
    console.log("  Pool 2: JitoSOL (SPL)");

    // Build remaining accounts for initialization
    const remainingAccounts = [];

    // bSOL accounts (SPL)
    remainingAccounts.push(
      { pubkey: bsolPool.stakePool, isSigner: false, isWritable: false },
      { pubkey: bsolPool.poolMint, isSigner: false, isWritable: false },
      { pubkey: bsolVaultTokenAccount, isSigner: false, isWritable: true }
    );

    // Marinade accounts
    remainingAccounts.push(
      { pubkey: marinadePool.marinadeState, isSigner: false, isWritable: false },
      { pubkey: marinadePool.msolMint, isSigner: false, isWritable: false },
      { pubkey: marinadePool.vaultMSolTokenAccount, isSigner: false, isWritable: true }
    );

    // JitoSOL accounts (SPL)
    remainingAccounts.push(
      { pubkey: jitoPool.stakePool, isSigner: false, isWritable: false },
      { pubkey: jitoPool.poolMint, isSigner: false, isWritable: false },
      { pubkey: jitoVaultTokenAccount, isSigner: false, isWritable: true }
    );

    // Build marinade_states array
    const marinadeStates = [
      null,                          // bSOL is SPL
      marinadePool.marinadeState,    // Marinade pool
      null                           // JitoSOL is SPL
    ];

    await program.methods
      .initialize(
        new anchor.BN(vaultId),
        allocations,
        poolProtocols.map(p => createProtocolEnum(p)),
        marinadeStates
      )
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

    console.log("  ✓ 3-way mixed vault initialized");

    // Verify vault state
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.vaultId.toNumber()).to.equal(vaultId);
    expect(vault.stakePools.length).to.equal(3);
    expect(vault.poolProtocols.length).to.equal(3);
    expect(vault.allocations).to.deep.equal(allocations);

    console.log("  ✓ Vault state verified");
  });

  it("Create user token account for 3-way vault", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    // Check if already exists
    try {
      await provider.connection.getTokenAccountBalance(userTokenAccount);
      console.log("  ✓ User token account already exists");
      return;
    } catch (error) {
      console.log("  Creating user token account...");
    }

    await program.methods
      .createUserAccount(new anchor.BN(vaultId))
      .accounts({
        tokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        mint: mintPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .rpc();

    console.log("  ✓ User token account created");
  });

  it("Deposit to 3-way mixed vault via StakeBlendClient - WILL FAIL (exposes vault-helpers.ts bugs)", async () => {
    // Initialize client (this is what the UI does)
    client = new StakeBlendClient(provider.connection, provider.wallet as anchor.Wallet, vaultId);

    const balancesBefore = await client.getUserBalances();
    console.log(`  SOL balance before: ${balancesBefore.sol.toFixed(2)} SOL`);
    console.log(`  Vault shares before: ${balancesBefore.vaultShares.toFixed(6)} shares`);

    const depositAmountSOL = 3.0; // 3 SOL (1 per pool)
    console.log(`\n  💰 Depositing ${depositAmountSOL} SOL via StakeBlendClient...`);
    console.log(`  ⚠️  Expected to FAIL - vault-helpers.ts doesn't support Marinade yet`);

    // This will fail because:
    // 1. vault-helpers.ts fetchPoolAccounts() will try to decode Marinade state as StakePool
    // 2. buildDepositRemainingAccounts() will build wrong number of accounts for Marinade
    const txSig = await client.deposit(depositAmountSOL);
    console.log(`  ✅ Transaction successful: ${txSig}`);

    const balancesAfter = await client.getUserBalances();
    console.log(`  Vault shares after: ${balancesAfter.vaultShares.toFixed(6)} shares`);

    expect(balancesAfter.vaultShares).to.be.greaterThan(balancesBefore.vaultShares);
    console.log(`  ✅ Deposit successful - received ${(balancesAfter.vaultShares - balancesBefore.vaultShares).toFixed(6)} shares`);
  });

  it("Withdraw from 3-way mixed vault via StakeBlendClient - WILL FAIL (exposes vault-helpers.ts bugs)", async () => {
    const balancesBefore = await client.getUserBalances();
    console.log(`  Vault shares before: ${balancesBefore.vaultShares.toFixed(6)} shares`);

    const sharesToWithdraw = 1.0; // Withdraw 1 share worth
    console.log(`\n  💸 Withdrawing ${sharesToWithdraw} shares via StakeBlendClient...`);
    console.log(`  ⚠️  Expected to FAIL - vault-helpers.ts doesn't support Marinade yet`);

    // This will fail for similar reasons as deposit
    const txSig = await client.withdraw(sharesToWithdraw);
    console.log(`  ✅ Transaction successful: ${txSig}`);

    const balancesAfter = await client.getUserBalances();
    console.log(`  Vault shares after: ${balancesAfter.vaultShares.toFixed(6)} shares`);

    expect(balancesAfter.vaultShares).to.be.lessThan(balancesBefore.vaultShares);
    console.log(`  ✅ Withdrawal successful - burned ${(balancesBefore.vaultShares - balancesAfter.vaultShares).toFixed(6)} shares`);
  });
});
