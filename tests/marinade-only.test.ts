import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  getPDAs,
  createMarinadePoolConfig,
  PoolProtocol,
  buildMixedDepositRemainingAccounts,
  buildMixedWithdrawRemainingAccounts,
} from "./fixtures";

describe("marinade-only vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;
  const vaultId = 1; // Use vault ID 1 for Marinade-only tests
  const marinadeAllocation = [10000]; // 100% Marinade

  let marinadeConfig: any;
  let mintPda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;
  let userTokenAccount: anchor.web3.PublicKey;

  before(async () => {
    ({ mintPda, vaultPda } = getPDAs(program.programId, vaultId));
    marinadeConfig = createMarinadePoolConfig(vaultPda);
    userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    console.log("Marinade-only vault setup:");
    console.log("  Vault PDA:", vaultPda.toString());
    console.log("  Mint PDA:", mintPda.toString());
    console.log("  Marinade State:", marinadeConfig.marinadeState.toString());
    console.log("  mSOL Mint:", marinadeConfig.msolMint.toString());
  });

  it("Initialize Marinade-only vault (100% allocation)", async () => {
    // Check if vault already exists
    try {
      await program.account.vault.fetch(vaultPda);
      console.log("  ✓ Vault already initialized, skipping");
      return;
    } catch (error) {
      console.log("  Initializing new Marinade-only vault...");
    }

    // Build remaining accounts for initialization (3 per pool)
    const remainingAccounts = [
      { pubkey: marinadeConfig.stakePool, isSigner: false, isWritable: false }, // marinade_state
      { pubkey: marinadeConfig.poolMint, isSigner: false, isWritable: false },  // msol_mint
      { pubkey: marinadeConfig.vaultPoolTokenAccount, isSigner: false, isWritable: true }, // vault mSOL ATA
    ];

    // Pool protocols: Marinade (Anchor enum format)
    const poolProtocols = [{ marinade: {} }];

    // Marinade states: required for Marinade pools
    const marinadeStates = [marinadeConfig.marinadeState];

    await program.methods
      .initialize(
        new anchor.BN(vaultId),
        marinadeAllocation,
        poolProtocols,
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

    console.log("  ✓ Marinade vault initialized");

    // Verify vault state
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.stakePools.length).to.equal(1);
    expect(vault.poolProtocols.length).to.equal(1);
    expect(vault.poolProtocols[0]).to.deep.equal({ marinade: {} });
    expect(vault.marinadeStates.length).to.equal(1);
    expect(vault.marinadeStates[0].toString()).to.equal(
      marinadeConfig.marinadeState.toString()
    );
  });

  it("Create user token account", async () => {
    try {
      await provider.connection.getTokenAccountBalance(userTokenAccount);
      console.log("  ✓ User token account exists");
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

  it("Deposit 1 SOL to Marinade vault", async () => {
    const depositAmount = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL);

    // Get user balance before
    const userBalanceBefore = await provider.connection.getBalance(
      provider.wallet.publicKey
    );

    // Build remaining accounts for Marinade deposit
    const poolConfigs = [marinadeConfig];
    const poolProtocols = [PoolProtocol.Marinade];
    const remainingAccounts = buildMixedDepositRemainingAccounts(
      poolConfigs,
      poolProtocols
    );

    console.log(`  Depositing ${depositAmount.toNumber() / anchor.web3.LAMPORTS_PER_SOL} SOL...`);

    await program.methods
      .deposit(new anchor.BN(vaultId), depositAmount)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: new anchor.web3.PublicKey(
          "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"
        ),
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log("  ✓ Deposit successful");

    // Verify vault shares minted
    const userBalance = await provider.connection.getTokenAccountBalance(
      userTokenAccount
    );
    const sharesMinted = parseInt(userBalance.value.amount);

    console.log(`  Shares minted: ${sharesMinted / anchor.web3.LAMPORTS_PER_SOL}`);
    expect(sharesMinted).to.be.greaterThan(0);

    // Verify vault mSOL balance
    const vaultMSolBalance = await provider.connection.getTokenAccountBalance(
      marinadeConfig.vaultMSolTokenAccount
    );

    console.log(`  Vault mSOL balance: ${vaultMSolBalance.value.uiAmount}`);
    expect(parseFloat(vaultMSolBalance.value.amount)).to.be.greaterThan(0);
  });

  it("Withdraw 0.5 SOL from Marinade vault", async () => {
    // Get current user shares
    const userBalance = await provider.connection.getTokenAccountBalance(
      userTokenAccount
    );
    const currentShares = parseInt(userBalance.value.amount);

    // Withdraw half
    const sharesToWithdraw = new anchor.BN(Math.floor(currentShares / 2));

    console.log(`  Withdrawing ${sharesToWithdraw.toNumber() / anchor.web3.LAMPORTS_PER_SOL} shares...`);

    // Get user SOL balance before
    const userSolBefore = await provider.connection.getBalance(
      provider.wallet.publicKey
    );

    // Build remaining accounts for Marinade withdrawal
    const poolConfigs = [marinadeConfig];
    const poolProtocols = [PoolProtocol.Marinade];
    const remainingAccounts = buildMixedWithdrawRemainingAccounts(
      poolConfigs,
      poolProtocols
    );

    await program.methods
      .withdraw(new anchor.BN(vaultId), sharesToWithdraw)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: new anchor.web3.PublicKey(
          "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"
        ),
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
        stakeProgram: new anchor.web3.PublicKey(
          "Stake11111111111111111111111111111111111111"
        ),
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log("  ✓ Withdrawal successful");

    // Verify shares burned
    const userBalanceAfter = await provider.connection.getTokenAccountBalance(
      userTokenAccount
    );
    const sharesAfter = parseInt(userBalanceAfter.value.amount);

    console.log(`  Shares after withdrawal: ${sharesAfter / anchor.web3.LAMPORTS_PER_SOL}`);
    expect(sharesAfter).to.be.lessThan(currentShares);
    expect(sharesAfter).to.be.approximately(currentShares / 2, 1000);

    // Verify user received SOL (accounting for transaction fees)
    const userSolAfter = await provider.connection.getBalance(
      provider.wallet.publicKey
    );

    console.log(`  SOL received: ~${(userSolAfter - userSolBefore) / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    expect(userSolAfter).to.be.greaterThan(userSolBefore);
  });

  it("Verify vault total value after deposit and withdrawal", async () => {
    const vault = await program.account.vault.fetch(vaultPda);

    console.log(`  Total shares issued: ${vault.totalSharesIssued.toNumber() / anchor.web3.LAMPORTS_PER_SOL}`);

    // Get vault mSOL balance
    const vaultMSolBalance = await provider.connection.getTokenAccountBalance(
      marinadeConfig.vaultMSolTokenAccount
    );

    console.log(`  Vault mSOL balance: ${vaultMSolBalance.value.uiAmount}`);

    // Vault should still have mSOL (since we only withdrew half)
    expect(parseFloat(vaultMSolBalance.value.amount)).to.be.greaterThan(0);
  });
});
