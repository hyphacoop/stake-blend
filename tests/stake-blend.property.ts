import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { StakePoolLayout } from '@solana/spl-stake-pool';
import * as fc from 'fast-check';
import { pools, expectedAllocations, STAKE_POOL_PROGRAM, getPDAs, setupTests } from './fixtures';

/**
 * Property-Based Tests for Stake Blend Vault
 *
 * These tests validate invariants and properties that should hold across
 * a wide range of inputs using randomized testing with fast-check.
 */

describe("stake-blend property tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;

  const vaultId = 0;
  // Get PDAs
  const { mintPda, vaultPda } = getPDAs(program.programId, vaultId);

  // Initialize vault and user account before tests
  before(async () => {
    await setupTests(program, provider, vaultId);
  });

  // ============================================================================
  // Helper Functions
  // ============================================================================

  async function getVaultState() {
    const vault = await program.account.vault.fetch(vaultPda);
    return vault;
  }

  async function getUserShares(): Promise<bigint> {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );
    const balance = await provider.connection.getTokenAccountBalance(userTokenAccount);
    return BigInt(balance.value.amount);
  }

  async function getLSTValue(stakePoolPubkey: anchor.web3.PublicKey): Promise<number> {
    const stakePoolAccount = await provider.connection.getAccountInfo(stakePoolPubkey);
    if (!stakePoolAccount) throw new Error("Stake pool account not found");
    const stakePool = StakePoolLayout.decode(stakePoolAccount.data);
    return stakePool.totalLamports.toNumber() / stakePool.poolTokenSupply.toNumber();
  }

  async function getTotalVaultValue(): Promise<bigint> {
    let totalValue = 0n;

    for (let i = 0; i < pools.length; i++) {
      const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
        pools[i].poolMint,
        vaultPda,
        true
      );

      const balance = await provider.connection.getTokenAccountBalance(vaultPoolTokenAccount);
      const tokenAmount = BigInt(balance.value.amount);

      const lstValue = await getLSTValue(pools[i].stakePool);
      const solValue = BigInt(Math.floor(Number(tokenAmount) * lstValue));

      totalValue += solValue;
    }

    return totalValue;
  }

  async function getSharePrice(): Promise<number> {
    const vault = await getVaultState();
    const totalValue = await getTotalVaultValue();

    if (vault.totalSharesIssued.isZero()) {
      return 1.0; // 1:1 for first deposit
    }

    return Number(totalValue) / vault.totalSharesIssued.toNumber();
  }

  function buildDepositRemainingAccounts() {
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
    return remainingAccounts;
  }

  function buildWithdrawRemainingAccounts() {
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
    return remainingAccounts;
  }

  async function deposit(amount: bigint) {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    await program.methods
      .deposit(new anchor.BN(vaultId), new anchor.BN(amount.toString()))
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
      })
      .remainingAccounts(buildDepositRemainingAccounts())
      .rpc();
  }

  async function withdraw(shares: bigint) {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    await program.methods
      .withdraw(new anchor.BN(vaultId), new anchor.BN(shares.toString()))
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
      .remainingAccounts(buildWithdrawRemainingAccounts())
      .rpc();
  }

  // ============================================================================
  // Property Tests: Deposit Invariants
  // ============================================================================

  describe("Deposit Invariants", () => {
    it("Property: Share price never decreases from deposits alone", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.nat({ max: 100 }).map(n => BigInt(n * 100_000_000)), // 0-10 SOL
          async (depositAmount) => {
            if (depositAmount === 0n) return true; // Skip zero deposits

            const sharePriceBefore = await getSharePrice();
            await deposit(depositAmount);
            const sharePriceAfter = await getSharePrice();

            // Share price can decrease slightly due to stake pool fees
            // Allow up to 2% decrease (covers typical stake pool fees of 0.3-1% plus some margin)
            const priceDiff = sharePriceAfter - sharePriceBefore;
            const maxDecrease = sharePriceBefore * 0.02;

            expect(priceDiff).to.be.at.least(-maxDecrease,
              `Share price decreased too much: ${sharePriceBefore} -> ${sharePriceAfter}`)

            return true;
          }
        ),
        { numRuns: 10 } // Limited runs due to blockchain interaction
      );
    });

    it("Property: First deposit mints shares 1:1", async () => {
      // This test assumes vault starts empty
      const vault = await getVaultState();
      if (!vault.totalSharesIssued.isZero()) {
        console.log("Skipping first deposit test - vault not empty");
        return;
      }

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }).map(n => BigInt(n * 100_000_000)), // 0.1-1 SOL
          async (depositAmount) => {
            const sharesBefore = await getUserShares();
            await deposit(depositAmount);
            const sharesAfter = await getUserShares();

            const sharesMinted = sharesAfter - sharesBefore;

            // For first deposit, shares should equal amount deposited (1:1)
            // Allow for small rounding differences and fees
            const diff = Number(sharesMinted - depositAmount);
            const tolerance = Number(depositAmount) * 0.05; // 5% tolerance for fees

            expect(Math.abs(diff)).to.be.lessThan(tolerance);

            return true;
          }
        ),
        { numRuns: 1 } // Only run once since it requires empty vault
      );
    });

    it("Property: Proportional share minting based on vault value", async () => {
      // Ensure vault has some value first
      const vault = await getVaultState();
      if (vault.totalSharesIssued.isZero()) {
        await deposit(1_000_000_000n); // Seed with 1 SOL
      }

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }).map(n => BigInt(n * 50_000_000)), // 0.05-1 SOL
          async (depositAmount) => {
            const totalSharesBefore = (await getVaultState()).totalSharesIssued.toNumber();
            const vaultValueBefore = await getTotalVaultValue();
            const userSharesBefore = await getUserShares();

            await deposit(depositAmount);

            const userSharesAfter = await getUserShares();
            const sharesMinted = Number(userSharesAfter - userSharesBefore);

            // Expected shares: amount * total_shares / vault_value
            const expectedShares = (Number(depositAmount) * totalSharesBefore) / Number(vaultValueBefore);

            // Allow 5% tolerance for fees and rounding
            const diff = Math.abs(sharesMinted - expectedShares);
            const tolerance = expectedShares * 0.05;

            expect(diff).to.be.lessThan(tolerance);

            return true;
          }
        ),
        { numRuns: 5 }
      );
    });
  });

  // ============================================================================
  // Property Tests: Withdrawal Invariants
  // ============================================================================

  describe("Withdrawal Invariants", () => {
    // Ensure vault has funds for withdrawal tests
    before(async () => {
      const vault = await getVaultState();
      if (vault.totalSharesIssued.toNumber() < 1_000_000_000) {
        await deposit(5_000_000_000n); // Seed with 5 SOL worth
      }
    });

    it("Property: User receives proportional value when withdrawing", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }).map(n => BigInt(n * 10_000_000)), // Small withdrawals
          async (sharesToWithdraw) => {
            const userShares = await getUserShares();
            if (userShares === 0n || sharesToWithdraw > userShares) {
              return true; // Skip if no shares or trying to withdraw too much
            }

            const totalSharesBefore = (await getVaultState()).totalSharesIssued;
            const vaultValueBefore = await getTotalVaultValue();
            const userSolBefore = await provider.connection.getBalance(provider.wallet.publicKey);

            await withdraw(sharesToWithdraw);

            const userSolAfter = await provider.connection.getBalance(provider.wallet.publicKey);
            const solReceived = BigInt(userSolAfter - userSolBefore);

            // Expected SOL: (shares / total_shares) * vault_value
            const expectedSol = (Number(sharesToWithdraw) * Number(vaultValueBefore)) /
                                totalSharesBefore.toNumber();

            // Allow 5% tolerance for fees and rounding
            const diff = Math.abs(Number(solReceived) - expectedSol);
            const tolerance = expectedSol * 0.05;

            expect(diff).to.be.lessThan(tolerance);

            return true;
          }
        ),
        { numRuns: 5 }
      );
    });

    it("Property: Total shares decrease by withdrawn amount", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }).map(n => BigInt(n * 10_000_000)),
          async (sharesToWithdraw) => {
            const userShares = await getUserShares();
            if (userShares === 0n || sharesToWithdraw > userShares) {
              return true;
            }

            const totalSharesBefore = (await getVaultState()).totalSharesIssued;
            await withdraw(sharesToWithdraw);
            const totalSharesAfter = (await getVaultState()).totalSharesIssued;

            const sharesBurned = totalSharesBefore.sub(totalSharesAfter);

            expect(sharesBurned.toString()).to.equal(sharesToWithdraw.toString());

            return true;
          }
        ),
        { numRuns: 5 }
      );
    });
  });

  // ============================================================================
  // Property Tests: Round-trip Properties
  // ============================================================================

  describe("Round-trip Properties", () => {
    it("Property: Deposit then immediate full withdrawal returns ~same amount", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }).map(n => BigInt(n * 100_000_000)), // 0.1-1 SOL
          async (depositAmount) => {
            const solBefore = await provider.connection.getBalance(provider.wallet.publicKey);
            const sharesBefore = await getUserShares();
            const vaultValueBefore = await getTotalVaultValue();

            // Deposit
            await deposit(depositAmount);

            const sharesAfter = await getUserShares();
            const sharesMinted = sharesAfter - sharesBefore;
            const vaultValueAfter = await getTotalVaultValue();
            const sharePriceAfter = await getSharePrice();
            const totalSharesAfter = (await getVaultState()).totalSharesIssued;

            // Withdraw all shares just minted
            await withdraw(sharesMinted);

            const solAfter = await provider.connection.getBalance(provider.wallet.publicKey);
            const netChange = solAfter - solBefore;

            // Calculate actual amount received back (not including deposit)
            const amountReceivedBack = netChange + Number(depositAmount);
            const actualLoss = Number(depositAmount) - amountReceivedBack;

            // Should get back most of deposit (minus fees and gas)
            // Allow up to 2% loss for double fees (deposit + withdrawal) plus gas
            const maxLoss = Number(depositAmount) * 0.02;

            expect(actualLoss).to.be.lessThan(maxLoss,
              `Round-trip loss too high: ${actualLoss} lamports loss on ${depositAmount} deposit`);

            return true;
          }
        ),
        { numRuns: 3 }
      );
    });
  });

  // ============================================================================
  // Property Tests: Account Validation
  // ============================================================================

  describe("Account Validation Properties", () => {
    it("Property: Wrong stake pool in any position should fail", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: pools.length - 1 }),
          async (poolIndexToSwap) => {
            const userTokenAccount = getAssociatedTokenAddressSync(
              mintPda,
              provider.wallet.publicKey
            );
            const depositAmount = new anchor.BN(100_000_000);

            // Build accounts with wrong stake pool at specified index
            const remainingAccounts = [];
            for (let i = 0; i < pools.length; i++) {
              const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
                pools[i].poolMint,
                vaultPda,
                true
              );

              const poolToUse = i === poolIndexToSwap ? pools[(i + 1) % pools.length] : pools[i];

              remainingAccounts.push(
                { pubkey: poolToUse.stakePool, isSigner: false, isWritable: true }, // WRONG if i === poolIndexToSwap
                { pubkey: pools[i].withdrawAuthority, isSigner: false, isWritable: false },
                { pubkey: pools[i].reserve, isSigner: false, isWritable: true },
                { pubkey: pools[i].poolMint, isSigner: false, isWritable: true },
                { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
                { pubkey: pools[i].managerFee, isSigner: false, isWritable: true },
                { pubkey: pools[i].managerFee, isSigner: false, isWritable: true }
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

              // Should not reach here
              return false;
            } catch (error: any) {
              // Should fail with InvalidAccountData
              return error.message.includes("InvalidAccountData");
            }
          }
        ),
        { numRuns: 5 }
      );
    });

    it("Property: Wrong withdraw authority should fail", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: pools.length - 1 }),
          async (poolIndexToSwap) => {
            const userTokenAccount = getAssociatedTokenAddressSync(
              mintPda,
              provider.wallet.publicKey
            );
            const depositAmount = new anchor.BN(100_000_000);

            const remainingAccounts = [];
            for (let i = 0; i < pools.length; i++) {
              const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
                pools[i].poolMint,
                vaultPda,
                true
              );

              const withdrawAuthToUse = i === poolIndexToSwap ?
                pools[(i + 1) % pools.length].withdrawAuthority :
                pools[i].withdrawAuthority;

              remainingAccounts.push(
                { pubkey: pools[i].stakePool, isSigner: false, isWritable: true },
                { pubkey: withdrawAuthToUse, isSigner: false, isWritable: false }, // WRONG if i === poolIndexToSwap
                { pubkey: pools[i].reserve, isSigner: false, isWritable: true },
                { pubkey: pools[i].poolMint, isSigner: false, isWritable: true },
                { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
                { pubkey: pools[i].managerFee, isSigner: false, isWritable: true },
                { pubkey: pools[i].managerFee, isSigner: false, isWritable: true }
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

              return false;
            } catch (error: any) {
              return error.message.includes("InvalidAccountData");
            }
          }
        ),
        { numRuns: 5 }
      );
    });

    it("Property: Wrong number of remaining accounts should fail", async () => {
      const userTokenAccount = getAssociatedTokenAddressSync(
        mintPda,
        provider.wallet.publicKey
      );
      const depositAmount = new anchor.BN(100_000_000);
      const correctCount = pools.length * 7; // 14 for 2 pools

      // Test too few accounts
      const tooFewCounts = [0, 5, 10, 13];
      for (const numAccounts of tooFewCounts) {
        const remainingAccounts = buildDepositRemainingAccounts().slice(0, numAccounts);

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

          throw new Error(`Transaction succeeded with ${numAccounts} accounts (expected to fail!)`);
        } catch (error: any) {
          const errorMsg = error.message || error.toString();
          expect(errorMsg).to.satisfy((msg: string) =>
            msg.includes("AccountNotEnoughKeys") ||
            msg.includes("not enough account keys") ||
            msg.includes("InvalidAccountData")
          );
        }
      }

      // Test too many accounts by adding duplicates
      const tooManyCounts = [15, 16, 20];
      for (const numAccounts of tooManyCounts) {
        const baseAccounts = buildDepositRemainingAccounts();
        // Add extra dummy accounts by duplicating the first account
        const remainingAccounts = [...baseAccounts];
        while (remainingAccounts.length < numAccounts) {
          remainingAccounts.push(baseAccounts[0]);
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

          throw new Error(`Transaction succeeded with ${numAccounts} accounts (expected to fail!)`);
        } catch (error: any) {
          const errorMsg = error.message || error.toString();
          expect(errorMsg).to.satisfy((msg: string) =>
            msg.includes("AccountNotEnoughKeys") ||
            msg.includes("not enough account keys") ||
            msg.includes("InvalidAccountData")
          );
        }
      }
    });
  });

  // ============================================================================
  // Property Tests: Allocation Properties
  // ============================================================================

  describe("Allocation Properties", () => {
    it("Property: Allocations always sum to 10000 bps", async () => {
      const vault = await getVaultState();
      const sum = vault.allocations.reduce((acc, alloc) => acc + alloc, 0);
      expect(sum).to.equal(10000);
    });

    it("Property: After multiple deposits, value distribution approximates target", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 10 }).map(n => BigInt(n * 100_000_000)), { minLength: 2, maxLength: 5 }),
          async (depositAmounts) => {
            // Make multiple deposits
            for (const amount of depositAmounts) {
              await deposit(amount);
            }

            // Check final distribution
            const poolValues = [];
            let totalValue = 0n;

            for (let i = 0; i < pools.length; i++) {
              const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
                pools[i].poolMint,
                vaultPda,
                true
              );

              const balance = await provider.connection.getTokenAccountBalance(vaultPoolTokenAccount);
              const tokenAmount = BigInt(balance.value.amount);

              const lstValue = await getLSTValue(pools[i].stakePool);
              const solValue = BigInt(Math.floor(Number(tokenAmount) * lstValue));

              poolValues.push(solValue);
              totalValue += solValue;
            }

            // Calculate actual allocations in bps
            const actualAllocations = poolValues.map(value =>
              totalValue > 0n ? Number((value * 10000n) / totalValue) : 0
            );

            // Allow 200 bps (2%) tolerance due to fees and timing
            const tolerance = 200;
            for (let i = 0; i < expectedAllocations.length; i++) {
              const diff = Math.abs(actualAllocations[i] - expectedAllocations[i]);
              expect(diff).to.be.lessThan(tolerance);
            }

            return true;
          }
        ),
        { numRuns: 3 }
      );
    });
  });
});
