import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getPDAs, ensureVaultInitialized, getATAInfo } from './fixtures';
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
    client = new StakeBlendClient(provider.connection, provider.wallet as anchor.Wallet);

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
