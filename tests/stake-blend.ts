import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { StakePoolLayout } from '@solana/spl-stake-pool';

describe("stake-blend", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;
  
  // Pool configuration - easy to expand later
  const pools = [
    // Mainnet / Local
    {
      // BSol
      stakePool: new anchor.web3.PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi"),
      poolMint: new anchor.web3.PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"),
      reserve: new anchor.web3.PublicKey("rsrxDvYUXjH1RQj2Ke36LNZEVqGztATxFkqNukERqFT"),
      withdrawAuthority: new anchor.web3.PublicKey("6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2"),
      managerFee: new anchor.web3.PublicKey("Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1"),
    },
    {
      // saveSOL
      stakePool: new anchor.web3.PublicKey("SAVEY1fVMBeRVo9V9rgEz8ENTvHreftd3QgpAKBDFV4"),
      poolMint: new anchor.web3.PublicKey("SAVEDpx3nFNdzG3ymJfShYnrBuYy7LtQEABZQ3qtTFt"),
      reserve: new anchor.web3.PublicKey("FL2AsvZPTW33QdmBgQx15ZdtaSbmuwY3oBCJMj63u9W1"),
      withdrawAuthority: new anchor.web3.PublicKey("9yWcz4S27nXKpsVmWqaimphCUnFo441JUvwkzmvRWys3"),
      managerFee: new anchor.web3.PublicKey("5VyLWq6nGg8mkAsHUwn6KqnaTni6hFZHb6dGiV7dCtGz"),
    },
  ];

  const expectedAllocations = [70_00, 30_00]; // 70% BSol, 30% saveSOL

  // Mainnet / Local
  const STAKE_POOL_PROGRAM = new anchor.web3.PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");

  // PDAs
  const [mintPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint")],
    program.programId
  );

  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );

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

  it("Initializes the vault", async () => {
    // Build remaining accounts: 3 per pool (stake_pool, pool_mint, ata)
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
          // tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();

    console.log("Vault initialized");
  });

  it("Creates a user account", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );
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

    console.log("User token account created");
  });

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
      .deposit(depositAmount)
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
      .withdraw(sharesToWithdraw)
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
        .deposit(depositAmount)
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
        .deposit(depositAmount)
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
        .deposit(depositAmount)
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
        .deposit(depositAmount)
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
});
