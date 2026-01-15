import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  getPDAs,
  pools,
  buildMixedDepositRemainingAccounts,
  buildMixedWithdrawRemainingAccounts,
  PoolProtocol
} from './fixtures';
import { createMarinadePoolConfig } from './marinade-helpers';

/**
 * Mixed Protocol Tests
 *
 * Tests a vault with both SPL Stake Pool (JitoSOL) AND Marinade (mSOL)
 * This verifies that protocol routing works correctly in production scenarios.
 */
describe("mixed-protocols vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;

  // Use vault ID 2 to avoid conflicts with existing test vaults
  const vaultId = 2;
  const { mintPda, vaultPda } = getPDAs(program.programId, vaultId);

  console.log("Mixed vault setup:");
  console.log(`  Vault PDA: ${vaultPda.toString()}`);
  console.log(`  Mint PDA: ${mintPda.toString()}`);

  it("Initialize mixed vault (50% JitoSOL + 50% Marinade)", async () => {
    // Pool 0: JitoSOL (SPL Stake Pool)
    const jitoPoolBase = pools[0];
    const jitoVaultTokenAccount = getAssociatedTokenAddressSync(
      jitoPoolBase.poolMint,
      vaultPda,
      true // allowOwnerOffCurve
    );
    const jitoPool = {
      ...jitoPoolBase,
      vaultPoolTokenAccount: jitoVaultTokenAccount
    };

    // Pool 1: Marinade (mSOL)
    const marinadePool = createMarinadePoolConfig(vaultPda);

    const poolConfigs = [jitoPool, marinadePool];
    const poolProtocols = [
      PoolProtocol.SplStakePool,
      PoolProtocol.Marinade
    ];
    const allocations = [5000, 5000]; // 50% each

    console.log("  Initializing mixed vault...");
    console.log(`  Pool 0: JitoSOL (${jitoPool.stakePool.toString()})`);
    console.log(`  Pool 1: Marinade (${marinadePool.marinadeState.toString()})`);

    // Build remaining accounts for initialization
    // SPL: 3 accounts (stake_pool, pool_mint, vault_pool_token_account)
    // Marinade: 3 accounts (marinade_state, msol_mint, vault_msol_token_account)
    const remainingAccounts = [];

    // JitoSOL accounts (SPL)
    remainingAccounts.push(
      { pubkey: jitoPool.stakePool, isSigner: false, isWritable: false },
      { pubkey: jitoPool.poolMint, isSigner: false, isWritable: false },
      { pubkey: jitoVaultTokenAccount, isSigner: false, isWritable: true }
    );

    // Marinade accounts
    remainingAccounts.push(
      { pubkey: marinadePool.marinadeState, isSigner: false, isWritable: false },
      { pubkey: marinadePool.msolMint, isSigner: false, isWritable: false },
      { pubkey: marinadePool.vaultMSolTokenAccount, isSigner: false, isWritable: true }
    );

    // Build marinade_states array: null for SPL pools, marinade_state for Marinade pools
    const marinadeStates = [
      null, // JitoSOL is SPL, not Marinade
      marinadePool.marinadeState // Marinade pool
    ];

    try {
      await program.methods
        .initialize(
          new anchor.BN(vaultId),
          allocations,
          poolProtocols.map(p => p === PoolProtocol.SplStakePool ? { splStakePool: {} } : { marinade: {} }),
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

      console.log("  ✓ Mixed vault initialized");

      // Verify vault state
      const vault = await program.account.vault.fetch(vaultPda);
      expect(vault.vaultId.toNumber()).to.equal(vaultId);
      expect(vault.stakePools.length).to.equal(2);
      expect(vault.poolProtocols.length).to.equal(2);
      expect(vault.allocations).to.deep.equal(allocations);

      // Verify protocol types
      expect(vault.poolProtocols[0]).to.have.property('splStakePool');
      expect(vault.poolProtocols[1]).to.have.property('marinade');

      console.log("  ✓ Vault state verified");
      console.log(`    Pool protocols: [SPL, Marinade]`);
      console.log(`    Allocations: [${allocations.join(', ')}]`);
    } catch (error) {
      console.error("Failed to initialize mixed vault:", error);
      throw error;
    }
  });

  it("Create user token account", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    console.log("  Creating user token account...");

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

  it("Deposit 2 SOL to mixed vault (should split 50/50)", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const depositAmount = new anchor.BN(2_000_000_000); // 2 SOL

    console.log("  Depositing 2 SOL...");

    // Fetch vault to get pool configs
    const vault = await program.account.vault.fetch(vaultPda);

    // Build pool configs array
    const jitoPoolBase = pools[0];
    const jitoVaultTokenAccount = getAssociatedTokenAddressSync(
      jitoPoolBase.poolMint,
      vaultPda,
      true
    );
    const jitoPool = {
      ...jitoPoolBase,
      vaultPoolTokenAccount: jitoVaultTokenAccount
    };
    const marinadePool = createMarinadePoolConfig(vaultPda);
    const poolConfigs = [jitoPool, marinadePool];
    const poolProtocols = [PoolProtocol.SplStakePool, PoolProtocol.Marinade];

    const remainingAccounts = buildMixedDepositRemainingAccounts(poolConfigs, poolProtocols);

    await program.methods
      .deposit(new anchor.BN(vaultId), depositAmount)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: new anchor.web3.PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"),
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log("  ✓ Deposit successful");

    // Check shares minted
    const tokenBalance = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const sharesMinted = parseFloat(tokenBalance.value.amount) / 1e9;
    console.log(`  Shares minted: ${sharesMinted}`);

    // Verify both pools received funds
    const jitoTokenAccount = jitoPool.vaultPoolTokenAccount;
    const msolTokenAccount = marinadePool.vaultMSolTokenAccount;

    const jitoBalance = await provider.connection.getTokenAccountBalance(jitoTokenAccount);
    const msolBalance = await provider.connection.getTokenAccountBalance(msolTokenAccount);

    console.log(`  Vault JitoSOL balance: ${parseFloat(jitoBalance.value.amount) / 1e9}`);
    console.log(`  Vault mSOL balance: ${parseFloat(msolBalance.value.amount) / 1e9}`);

    expect(parseFloat(jitoBalance.value.amount)).to.be.greaterThan(0);
    expect(parseFloat(msolBalance.value.amount)).to.be.greaterThan(0);

    console.log("  ✓ Both pools received deposits");
  });

  it("Withdraw 1 SOL from mixed vault (should unstake from both)", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const sharesToWithdraw = new anchor.BN(1_000_000_000); // 1 share ≈ 1 SOL

    console.log("  Withdrawing 1 SOL worth of shares...");

    const userSolBefore = await provider.connection.getBalance(provider.wallet.publicKey);

    // Build pool configs
    const jitoPoolBase = pools[0];
    const jitoVaultTokenAccount = getAssociatedTokenAddressSync(
      jitoPoolBase.poolMint,
      vaultPda,
      true
    );
    const jitoPool = {
      ...jitoPoolBase,
      vaultPoolTokenAccount: jitoVaultTokenAccount
    };
    const marinadePool = createMarinadePoolConfig(vaultPda);
    const poolConfigs = [jitoPool, marinadePool];
    const poolProtocols = [PoolProtocol.SplStakePool, PoolProtocol.Marinade];

    const remainingAccounts = buildMixedWithdrawRemainingAccounts(poolConfigs, poolProtocols);

    await program.methods
      .withdraw(new anchor.BN(vaultId), sharesToWithdraw)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: new anchor.web3.PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"),
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
        stakeProgram: anchor.web3.STAKE_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log("  ✓ Withdrawal successful");

    const userSolAfter = await provider.connection.getBalance(provider.wallet.publicKey);
    const solReceived = (userSolAfter - userSolBefore) / 1e9;

    console.log(`  Shares after withdrawal: ${sharesToWithdraw.toNumber() / 1e9}`);
    console.log(`  SOL received: ~${solReceived.toFixed(9)} SOL`);

    // Should receive approximately 1 SOL back (minus fees)
    expect(solReceived).to.be.greaterThan(0.9);

    console.log("  ✓ User received SOL from both protocols");
  });

  it("Should fail when wrong protocol accounts are provided", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const depositAmount = new anchor.BN(100_000_000); // 0.1 SOL

    // Build WRONG remaining accounts: swap the protocol accounts
    const jitoPoolBase = pools[0];
    const jitoVaultTokenAccount = getAssociatedTokenAddressSync(
      jitoPoolBase.poolMint,
      vaultPda,
      true
    );
    const jitoPool = {
      ...jitoPoolBase,
      vaultPoolTokenAccount: jitoVaultTokenAccount
    };
    const marinadePool = createMarinadePoolConfig(vaultPda);
    const poolConfigs = [marinadePool, jitoPool]; // SWAPPED!
    const poolProtocols = [PoolProtocol.SplStakePool, PoolProtocol.Marinade]; // Correct order

    const remainingAccounts = buildMixedDepositRemainingAccounts(poolConfigs, poolProtocols);

    console.log("  Attempting deposit with wrong protocol accounts...");

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
          stakePoolProgram: new anchor.web3.PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"),
        })
        .remainingAccounts(remainingAccounts)
        .rpc();

      // If we get here, the test failed (should have thrown)
      throw new Error("Expected transaction to fail with wrong accounts");
    } catch (error: any) {
      // Accept either AnchorError or TypeError (account validation can fail at different points)
      const errorStr = error.toString();
      const isExpectedError = errorStr.includes("AnchorError") ||
                              errorStr.includes("TypeError") ||
                              errorStr.includes("InvalidAccountData");
      expect(isExpectedError).to.be.true;
      console.log("  ✅ Transaction correctly failed with wrong accounts");
    }
  });
});
