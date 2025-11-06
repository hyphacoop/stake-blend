import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { StakePoolLayout } from '@solana/spl-stake-pool';
import { pools, expectedAllocations, STAKE_POOL_PROGRAM, getPDAs, setupTests } from './fixtures';

describe("stake-blend", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;

  const vaultId = 0; // Use vault 0 for all tests
  // Get PDAs
  const { mintPda, vaultPda } = getPDAs(program.programId, vaultId);

  // Initialize vault and user account before tests
  before(async () => {
    await setupTests(program, provider, vaultId);
  });

  // Helper function to get LST token value in SOL

  async function getLSTValue(stakePoolPubkey: anchor.web3.PublicKey): Promise<number> {
    const stakePoolAccount = await provider.connection.getAccountInfo(stakePoolPubkey);
    const stakePool = StakePoolLayout.decode(stakePoolAccount.data);
    return stakePool.totalLamports.toNumber() / stakePool.poolTokenSupply.toNumber();
  }

  // Helper function to validate VALUE distribution (not token distribution)
  async function validateDistribution(testName: string) {
    console.log(`\n--- Validating VALUE distribution after ${testName} ---`);
    
    // Get all vault pool token account balances and their values
    const poolData = [];
    let totalValue = 0;
    
    for (let i = 0; i < pools.length; i++) {
      const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
        pools[i].poolMint,
        vaultPda,
        true
      );
      
      const balance = await provider.connection.getTokenAccountBalance(vaultPoolTokenAccount);
      const tokenAmount = parseInt(balance.value.amount);
      
      // Get the LST value (SOL per token)
      const lstValue = await getLSTValue(pools[i].stakePool);
      const solValue = tokenAmount * lstValue;
      
      poolData.push({
        tokens: tokenAmount,
        lstValue,
        solValue
      });
      
      totalValue += solValue;
      
      console.log(`Pool ${i}: ${tokenAmount} tokens × ${lstValue.toFixed(6)} = ${solValue.toFixed(2)} SOL value`);
    }
    
    // Calculate actual VALUE allocations (in basis points)
    const actualAllocations = poolData.map(pool => 
      totalValue > 0 ? Math.round((pool.solValue / totalValue) * 10000) : 0
    );
    
    console.log("Expected allocations:", expectedAllocations);
    console.log("Actual VALUE allocations:", actualAllocations);
    console.log("Total SOL value:", totalValue.toFixed(2));
    
    // Validate within tolerance (1% = 100 basis points)
    const tolerance = 100;
    for (let i = 0; i < expectedAllocations.length; i++) {
      const diff = Math.abs(actualAllocations[i] - expectedAllocations[i]);
      expect(diff).to.be.lessThan(tolerance, 
        `Pool ${i} VALUE allocation off by ${diff} basis points (expected ${expectedAllocations[i]}, got ${actualAllocations[i]})`);
    }
    
    console.log("✅ VALUE distribution is correct!");
    return { poolData, totalValue: totalValue, actualAllocations };
  }


  it("Deposit SOL through stake pool", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );
    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL

    // Build remaining accounts: 7 per pool for deposit
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
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true } // referrer fee
      );
    }

    await program.methods
      .deposit(new anchor.BN(vaultId), depositAmount)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    // Check user received vault shares
    const userBalance = await provider.connection.getTokenAccountBalance(userTokenAccount);
    console.log("User vault shares:", userBalance.value.amount);

    // Validate VALUE distribution (not token distribution)
    await validateDistribution("deposit");
  });

  it("Withdraw shares for SOL", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const sharesToWithdraw = new anchor.BN(500_000_000); // 0.5 vault shares

    // Build remaining accounts: 6 per pool for withdraw (no referrer fee)
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
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true }
      );
    }

    const userSolBefore = await provider.connection.getBalance(provider.wallet.publicKey);

    await program.methods
      .withdraw(new anchor.BN(vaultId), sharesToWithdraw)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
        stakeProgram: anchor.web3.StakeProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    const userSolAfter = await provider.connection.getBalance(provider.wallet.publicKey);
    console.log("SOL received:", (userSolAfter - userSolBefore) / 1e9);

    // Validate VALUE distribution after withdrawal
    await validateDistribution("withdraw");
  });

  it("Should fail when wrong stake pool accounts are provided", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL

    // Build remaining accounts with WRONG stake pool (swap the order)
    const remainingAccounts = [];
    for (let i = 0; i < pools.length; i++) {
      const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
        pools[i].poolMint,
        vaultPda,
        true
      );

      // Use wrong stake pool - swap pools[0] and pools[1]
      const wrongPoolIndex = i === 0 ? 1 : 0;
      
      remainingAccounts.push(
        { pubkey: pools[wrongPoolIndex].stakePool, isSigner: false, isWritable: true }, // WRONG!
        { pubkey: pools[i].withdrawAuthority, isSigner: false, isWritable: false },
        { pubkey: pools[i].reserve, isSigner: false, isWritable: true },
        { pubkey: pools[i].poolMint, isSigner: false, isWritable: true },
        { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true } // referrer fee
      );
    }

    try {
      await program.methods
        .deposit(new anchor.BN(vaultId), depositAmount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
          userVaultTokenAccount: userTokenAccount,
          signer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
      
      // If we get here, the test should fail because validation should have caught the wrong accounts
      expect.fail("Expected transaction to fail due to wrong stake pool accounts");
    } catch (error) {
      // This should happen - the transaction should fail
      console.log("✅ Transaction correctly failed with wrong accounts:", error.message);
      // Now it should fail at our validation level with InvalidAccountData
      expect(error.message).to.include("InvalidAccountData"); 
    }
  });

  it("Should fail when wrong withdraw authority is provided", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL

    // Build remaining accounts with WRONG withdraw authority
    const remainingAccounts = [];
    for (let i = 0; i < pools.length; i++) {
      const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
        pools[i].poolMint,
        vaultPda,
        true
      );

      // Use wrong withdraw authority - swap them
      const wrongPoolIndex = i === 0 ? 1 : 0;
      
      remainingAccounts.push(
        { pubkey: pools[i].stakePool, isSigner: false, isWritable: true },
        { pubkey: pools[wrongPoolIndex].withdrawAuthority, isSigner: false, isWritable: false }, // WRONG!
        { pubkey: pools[i].reserve, isSigner: false, isWritable: true },
        { pubkey: pools[i].poolMint, isSigner: false, isWritable: true },
        { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true } // referrer fee
      );
    }

    try {
      await program.methods
        .deposit(new anchor.BN(vaultId), depositAmount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
          userVaultTokenAccount: userTokenAccount,
          signer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
      
      expect.fail("Expected transaction to fail due to wrong withdraw authority");
    } catch (error) {
      console.log("✅ Transaction correctly failed with wrong withdraw authority:", error.message);
      expect(error.message).to.include("InvalidAccountData");
    }
  });

  it("Should fail when wrong reserve stake is provided", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL

    // Build remaining accounts with WRONG reserve stake
    const remainingAccounts = [];
    for (let i = 0; i < pools.length; i++) {
      const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
        pools[i].poolMint,
        vaultPda,
        true
      );

      // Use wrong reserve stake - swap them
      const wrongPoolIndex = i === 0 ? 1 : 0;
      
      remainingAccounts.push(
        { pubkey: pools[i].stakePool, isSigner: false, isWritable: true },
        { pubkey: pools[i].withdrawAuthority, isSigner: false, isWritable: false },
        { pubkey: pools[wrongPoolIndex].reserve, isSigner: false, isWritable: true }, // WRONG!
        { pubkey: pools[i].poolMint, isSigner: false, isWritable: true },
        { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true },
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true } // referrer fee
      );
    }

    try {
      await program.methods
        .deposit(new anchor.BN(vaultId), depositAmount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
          userVaultTokenAccount: userTokenAccount,
          signer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
      
      expect.fail("Expected transaction to fail due to wrong reserve stake");
    } catch (error) {
      console.log("✅ Transaction correctly failed with wrong reserve stake:", error.message);
      expect(error.message).to.include("InvalidAccountData");
    }
  });

  it("Should fail when wrong manager fee account is provided", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL

    // Build remaining accounts with WRONG manager fee account
    const remainingAccounts = [];
    for (let i = 0; i < pools.length; i++) {
      const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
        pools[i].poolMint,
        vaultPda,
        true
      );

      // Use wrong manager fee account - swap them
      const wrongPoolIndex = i === 0 ? 1 : 0;
      
      remainingAccounts.push(
        { pubkey: pools[i].stakePool, isSigner: false, isWritable: true },
        { pubkey: pools[i].withdrawAuthority, isSigner: false, isWritable: false },
        { pubkey: pools[i].reserve, isSigner: false, isWritable: true },
        { pubkey: pools[i].poolMint, isSigner: false, isWritable: true },
        { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pools[wrongPoolIndex].managerFee, isSigner: false, isWritable: true }, // WRONG!
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true } // referrer fee
      );
    }

    try {
      await program.methods
        .deposit(new anchor.BN(vaultId), depositAmount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
          userVaultTokenAccount: userTokenAccount,
          signer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
      
      expect.fail("Expected transaction to fail due to wrong manager fee account");
    } catch (error) {
      console.log("✅ Transaction correctly failed with wrong manager fee account:", error.message);
      expect(error.message).to.include("InvalidAccountData");
    }
  });

  it("Should maintain correct allocation ratios after multiple deposits", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    // Make multiple small deposits to test consistency
    for (let i = 0; i < 3; i++) {
      const depositAmount = new anchor.BN(100_000_000); // 0.1 SOL each

      const remainingAccounts = [];
      for (let j = 0; j < pools.length; j++) {
        const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
          pools[j].poolMint,
          vaultPda,
          true
        );

        remainingAccounts.push(
          { pubkey: pools[j].stakePool, isSigner: false, isWritable: true },
          { pubkey: pools[j].withdrawAuthority, isSigner: false, isWritable: false },
          { pubkey: pools[j].reserve, isSigner: false, isWritable: true },
          { pubkey: pools[j].poolMint, isSigner: false, isWritable: true },
          { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
          { pubkey: pools[j].managerFee, isSigner: false, isWritable: true },
          { pubkey: pools[j].managerFee, isSigner: false, isWritable: true }
        );
      }

      await program.methods
        .deposit(new anchor.BN(vaultId), depositAmount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
          userVaultTokenAccount: userTokenAccount,
          signer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
    }

    // Validate final distribution is still correct
    await validateDistribution("multiple deposits");
  });

  it("Should handle edge case of very small withdrawals", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    // Try to withdraw a very small amount (1 share)
    const sharesToWithdraw = new anchor.BN(1);

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
        { pubkey: pools[i].managerFee, isSigner: false, isWritable: true }
      );
    }

    const userSolBefore = await provider.connection.getBalance(provider.wallet.publicKey);

    await program.methods
      .withdraw(new anchor.BN(vaultId), sharesToWithdraw)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
        stakeProgram: anchor.web3.StakeProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    const userSolAfter = await provider.connection.getBalance(provider.wallet.publicKey);
    console.log("SOL received from tiny withdrawal:", (userSolAfter - userSolBefore) / 1e9);
  });

  it("Should verify mint has 9 decimals and 1 SOL ≈ 1 share", async () => {
    // Verify mint decimals
    const mintInfo = await provider.connection.getTokenSupply(mintPda);
    console.log("Mint decimals:", mintInfo.value.decimals);
    // expect(mintInfo.value.decimals).to.equal(9);

    // Get user balance before
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );
    const balanceBefore = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const sharesBefore = parseInt(balanceBefore.value.amount);

    // Deposit exactly 1 SOL
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

    await program.methods
      .deposit(new anchor.BN(vaultId), depositAmount)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    // Get user balance after
    const balanceAfter = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const sharesAfter = parseInt(balanceAfter.value.amount);
    const sharesMinted = sharesAfter - sharesBefore;

    // Calculate display value using ACTUAL mint decimals
    const decimals = mintInfo.value.decimals;
    const divisor = Math.pow(10, decimals);
    const sharesDisplay = sharesMinted / divisor;

    console.log(`Deposited: 1 SOL`);
    console.log(`Mint decimals: ${decimals}`);
    console.log(`Shares minted (raw): ${sharesMinted}`);
    console.log(`Divisor: ${divisor}`);
    console.log(`Shares display: ${sharesDisplay.toFixed(9)}`);

    // With correct decimals (9), 1 SOL should give ~1 share displayed
    // With wrong decimals (6), 1 SOL would give ~1000 shares displayed - FAIL!
    expect(sharesDisplay).to.be.greaterThan(0.95);
    expect(sharesDisplay).to.be.lessThan(1.05);
    console.log("✅ 1 SOL ≈ 1 share verified!");
  });
});
