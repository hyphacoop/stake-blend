import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolTokenVault } from "../target/types/sol_token_vault";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

describe("sol-token-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolTokenVault as Program<SolTokenVault>;
  
  // PDAs
  const [mintPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint")],
    program.programId
  );

  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );

  const getAssociatedTokenAccount = (userPubkey: anchor.web3.PublicKey) => {
    return getAssociatedTokenAddressSync(
      mintPda,
      userPubkey,
      false, // allowOwnerOffCurve
      anchor.utils.token.TOKEN_PROGRAM_ID
    );
  };

  it("Initialize vault", async () => {
    await program.methods
      .initialize()
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Check that mint and vault were created
    const mintAccount = await provider.connection.getAccountInfo(mintPda);
    const vaultAccount = await provider.connection.getAccountInfo(vaultPda);
    expect(mintAccount).to.not.be.null;
    expect(vaultAccount).to.not.be.null;
  });

  it("Create user account", async () => {
    const userTokenAccount = getAssociatedTokenAccount(provider.wallet.publicKey);

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

    // Check that token account was created
    const tokenAccount = await provider.connection.getTokenAccountBalance(userTokenAccount);
    expect(tokenAccount.value.uiAmount).to.equal(0);
  });

  it("Deposit SOL and receive shares", async () => {
    const userTokenAccount = getAssociatedTokenAccount(provider.wallet.publicKey);
    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL

    const vaultBalanceBefore = await provider.connection.getBalance(vaultPda);
    
    await program.methods
      .deposit(depositAmount)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        associatedTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .rpc();

    const vaultBalanceAfter = await provider.connection.getBalance(vaultPda);
    const userTokenBalance = await provider.connection.getTokenAccountBalance(userTokenAccount);

    // Check that SOL was transferred to the vault account
    expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(depositAmount.toNumber());
    
    // Check user received tokenized shares (1:1 ratio for first deposit)
    expect(userTokenBalance.value.amount).to.equal(depositAmount.toString());
  });

  it("Second deposit maintains proportional shares", async () => {
    const userTokenAccount = getAssociatedTokenAccount(provider.wallet.publicKey);
    const secondDeposit = new anchor.BN(500_000_000); // 0.5 SOL

    const userTokenBalanceBefore = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPda);

    await program.methods
      .deposit(secondDeposit)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        associatedTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .rpc();

    const userTokenBalanceAfter = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const vaultBalanceAfter = await provider.connection.getBalance(vaultPda);

    // Check SOL was added to vault
    expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(secondDeposit.toNumber());
    
    // Check user received additional shares (1:1 in simple case)
    const expectedNewShares = parseInt(userTokenBalanceBefore.value.amount) + secondDeposit.toNumber();
    expect(userTokenBalanceAfter.value.amount).to.equal(expectedNewShares.toString());
  });

  it("Withdraw shares and receive SOL", async () => {
    const userTokenAccount = getAssociatedTokenAccount(provider.wallet.publicKey);
    const sharesToWithdraw = new anchor.BN(300_000_000); // 0.3 worth of shares

    const userBalanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);
    const userTokenBalanceBefore = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const vaultBalanceBefore = await provider.connection.getBalance(vaultPda);

    await program.methods
      .withdraw(sharesToWithdraw)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        associatedTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .rpc();

    const userBalanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);
    const userTokenBalanceAfter = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const vaultBalanceAfter = await provider.connection.getBalance(vaultPda);

    // Check shares were burned
    const expectedRemainingShares = parseInt(userTokenBalanceBefore.value.amount) - sharesToWithdraw.toNumber();
    expect(userTokenBalanceAfter.value.amount).to.equal(expectedRemainingShares.toString());

    // Check SOL was transferred from vault to user
    expect(vaultBalanceBefore - vaultBalanceAfter).to.equal(sharesToWithdraw.toNumber());
    
    // Check user received SOL (accounting for transaction fees)
    expect(userBalanceAfter).to.be.greaterThan(userBalanceBefore);
  });

  it("Multiple users can deposit and maintain proportional ownership", async () => {
    // Create a second user
    const secondUser = anchor.web3.Keypair.generate();
    const secondUserTokenAccount = getAssociatedTokenAccount(secondUser.publicKey);

    // Airdrop SOL to second user
    await provider.connection.requestAirdrop(secondUser.publicKey, 2_000_000_000);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for airdrop

    // Create second user token account
    await program.methods
      .createUserAccount()
      .accounts({
        tokenAccount: secondUserTokenAccount,
        signer: secondUser.publicKey,
        mint: mintPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .signers([secondUser])
      .rpc();

    // Second user deposits
    const secondUserDeposit = new anchor.BN(750_000_000); // 0.75 SOL
    await program.methods
      .deposit(secondUserDeposit)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        associatedTokenAccount: secondUserTokenAccount,
        signer: secondUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .signers([secondUser])
      .rpc();

    // Get token balances
    const firstUserTokenAccount = getAssociatedTokenAccount(provider.wallet.publicKey);
    const firstUserBalance = await provider.connection.getTokenAccountBalance(firstUserTokenAccount);
    const secondUserBalance = await provider.connection.getTokenAccountBalance(secondUserTokenAccount);

    // Get mint supply to calculate ownership percentages
    const mintInfo = await provider.connection.getTokenSupply(mintPda);
    const totalSupply = parseInt(mintInfo.value.amount);

    const firstUserShares = parseInt(firstUserBalance.value.amount);
    const secondUserShares = parseInt(secondUserBalance.value.amount);

    const firstUserOwnership = firstUserShares / totalSupply;
    const secondUserOwnership = secondUserShares / totalSupply;

    console.log(`First user owns ${(firstUserOwnership * 100).toFixed(2)}% of vault`);
    console.log(`Second user owns ${(secondUserOwnership * 100).toFixed(2)}% of vault`);

    expect(firstUserOwnership + secondUserOwnership).to.be.closeTo(1.0, 0.001);
  });
});