import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { pools, STAKE_POOL_PROGRAM, getPDAs, ensureVaultInitialized, getATAInfo } from './fixtures';

/**
 * E2E Tests for ATA Auto-Creation
 *
 * These tests verify that the UI client logic correctly auto-creates ATAs when needed.
 * We simulate the UI behavior by manually building transactions with createAssociatedTokenAccountInstruction
 * when the ATA doesn't exist.
 */
describe("stake-blend: ATA Auto-Creation (E2E)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;
  const { mintPda, vaultPda } = getPDAs(program.programId);

  // Initialize vault before tests (but NOT user account - we want to test auto-creation)
  before(async () => {
    await ensureVaultInitialized(program, provider);
    console.log("\n🧪 Testing ATA Auto-Creation Flow...\n");
  });

  it("Deposit with fresh wallet (no ATA) - should auto-create ATA", async () => {
    // Step 1: Check if ATA exists
    const ataInfoBefore = await getATAInfo(provider, mintPda, provider.wallet.publicKey);
    console.log(`ATA exists before deposit: ${ataInfoBefore.exists}`);

    // Step 2: Build deposit transaction
    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL
    const remainingAccounts = [];

    for (let i = 0; i < pools.length; i++) {
      const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
        pools[i].poolMint,
        vaultPda,
        true
      );

      remainingAccounts.push(
        { pubkey: pools[i].stakePool, isSigner: false, isWritable: true },
        { pubkey: pools[i].withdrawAuthority, isSigner: false, isWritable: false },
        { pubkey: pools[i].reserve, isSigner: false, isWritable: true },
        { pubkey: pools[i].poolMint, isSigner: false, isWritable: true },
        { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true }
      );
    }

    // Step 3: If ATA doesn't exist, we need to create it in the same transaction
    if (!ataInfoBefore.exists) {
      console.log("✨ ATA does not exist - creating in same transaction as deposit");

      // Create ATA instruction
      const createAtaIx = createAssociatedTokenAccountInstruction(
        provider.wallet.publicKey, // payer
        ataInfoBefore.address,      // ata
        provider.wallet.publicKey,  // owner
        mintPda                      // mint
      );

      // Get deposit instruction
      const depositIx = await program.methods
        .deposit(depositAmount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
          userVaultTokenAccount: ataInfoBefore.address,
          signer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .instruction();

      // Combine both instructions in one transaction
      const tx = new anchor.web3.Transaction();
      tx.add(createAtaIx);
      tx.add(depositIx);

      // Send transaction
      await provider.sendAndConfirm(tx);
      console.log("✅ Transaction sent with both createATA and deposit instructions");
    } else {
      // ATA exists - just deposit
      console.log("ATA already exists - depositing normally");
      await program.methods
        .deposit(depositAmount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
          userVaultTokenAccount: ataInfoBefore.address,
          signer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
    }

    // Step 4: Verify ATA was created and user received shares
    const ataInfoAfter = await getATAInfo(provider, mintPda, provider.wallet.publicKey);
    expect(ataInfoAfter.exists).to.be.true;
    console.log("✅ ATA exists after deposit");

    // Check user balance
    const userBalance = await provider.connection.getTokenAccountBalance(ataInfoAfter.address);
    const sharesReceived = parseInt(userBalance.value.amount);
    expect(sharesReceived).to.be.greaterThan(0);
    console.log(`✅ User received ${sharesReceived / 1e6} vault shares`);
  });

  it("Second deposit with existing ATA - should NOT create ATA again", async () => {
    // Step 1: Verify ATA exists from previous test
    const ataInfoBefore = await getATAInfo(provider, mintPda, provider.wallet.publicKey);
    expect(ataInfoBefore.exists).to.be.true;
    console.log("✓ ATA already exists from previous deposit");

    // Get balance before
    const balanceBefore = await provider.connection.getTokenAccountBalance(ataInfoBefore.address);
    const sharesBefore = parseInt(balanceBefore.value.amount);
    console.log(`Balance before: ${sharesBefore / 1e6} shares`);

    // Step 2: Deposit again (should skip ATA creation)
    const depositAmount = new anchor.BN(500_000_000); // 0.5 SOL
    const remainingAccounts = [];

    for (let i = 0; i < pools.length; i++) {
      const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
        pools[i].poolMint,
        vaultPda,
        true
      );

      remainingAccounts.push(
        { pubkey: pools[i].stakePool, isSigner: false, isWritable: true },
        { pubkey: pools[i].withdrawAuthority, isSigner: false, isWritable: false },
        { pubkey: pools[i].reserve, isSigner: false, isWritable: true },
        { pubkey: pools[i].poolMint, isSigner: false, isWritable: true },
        { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true }
      );
    }

    // Since ATA exists, just deposit (no createATA instruction)
    console.log("Depositing without createATA instruction...");
    await program.methods
      .deposit(depositAmount)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: ataInfoBefore.address,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log("✅ Deposit succeeded without ATA creation");

    // Step 3: Verify balance increased
    const balanceAfter = await provider.connection.getTokenAccountBalance(ataInfoBefore.address);
    const sharesAfter = parseInt(balanceAfter.value.amount);
    console.log(`Balance after: ${sharesAfter / 1e6} shares`);

    expect(sharesAfter).to.be.greaterThan(sharesBefore);
    console.log(`✅ Shares increased by ${(sharesAfter - sharesBefore) / 1e6}`);
  });

  it("Verify ATA auto-creation logic - getAccountInfo check", async () => {
    // This test demonstrates the logic used in the UI client
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    // Check if ATA exists (simulating UI logic)
    const accountInfo = await provider.connection.getAccountInfo(userTokenAccount);
    const ataExists = accountInfo !== null;

    console.log(`ATA exists: ${ataExists}`);
    console.log(`ATA address: ${userTokenAccount.toBase58()}`);

    // At this point in the test, ATA should exist from previous tests
    expect(ataExists).to.be.true;

    if (ataExists) {
      console.log("✅ UI would skip ATA creation and deposit directly");
    } else {
      console.log("✅ UI would create ATA + deposit in single transaction");
    }
  });
});
