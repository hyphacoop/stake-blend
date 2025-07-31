import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolTokenVault } from "../target/types/sol_token_vault";
import { expect } from "chai";

describe("sol-token-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolTokenVault as Program<SolTokenVault>;
  
  // PDAs
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );

  const getUserPda = (userPubkey: anchor.web3.PublicKey) => {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user"), userPubkey.toBuffer()],
      program.programId
    )[0];
  };

  it("Initialize vault", async () => {
    await program.methods
      .initialize()
      .accounts({
        vault: vaultPda,
        user: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.totalShares.toNumber()).to.equal(0);
    expect(vaultAccount.totalSol.toNumber()).to.equal(0);
  });

  it("Create user account", async () => {
    const userPda = getUserPda(provider.wallet.publicKey);

    await program.methods
      .createUserAccount()
      .accounts({
        userAccount: userPda,
        user: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const userAccount = await program.account.userAccount.fetch(userPda);
    expect(userAccount.shares.toNumber()).to.equal(0);
  });

  it("Deposit SOL and receive shares", async () => {
    const userPda = getUserPda(provider.wallet.publicKey);
    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL

    const vaultBalanceBefore = await provider.connection.getBalance(vaultPda);
    
    await program.methods
      .deposit(depositAmount)
      .accounts({
        vault: vaultPda,
        userAccount: userPda,
        user: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    const userAccount = await program.account.userAccount.fetch(userPda);
    const vaultBalanceAfter = await provider.connection.getBalance(vaultPda);

    // Check vault state
    expect(vaultAccount.totalShares.toNumber()).to.equal(depositAmount.toNumber());
    expect(vaultAccount.totalSol.toNumber()).to.equal(depositAmount.toNumber());
    
    // Check user shares
    expect(userAccount.shares.toNumber()).to.equal(depositAmount.toNumber());
    
    // Check actual SOL transfer
    expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(depositAmount.toNumber());
  });

  it("Second deposit maintains proportional shares (1:1 in simple case)", async () => {
    const userPda = getUserPda(provider.wallet.publicKey);
    const secondDeposit = new anchor.BN(500_000_000); // 0.5 SOL

    const userAccountBefore = await program.account.userAccount.fetch(userPda);
    const vaultAccountBefore = await program.account.vault.fetch(vaultPda);

    await program.methods
      .deposit(secondDeposit)
      .accounts({
        vault: vaultPda,
        userAccount: userPda,
        user: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    const userAccount = await program.account.userAccount.fetch(userPda);

    // In simple case (no external SOL additions), should be 1:1
    const expectedTotalShares = vaultAccountBefore.totalShares.add(secondDeposit);
    const expectedTotalSol = vaultAccountBefore.totalSol.add(secondDeposit);
    const expectedUserShares = userAccountBefore.shares.add(secondDeposit);

    expect(vaultAccount.totalShares.toNumber()).to.equal(expectedTotalShares.toNumber());
    expect(vaultAccount.totalSol.toNumber()).to.equal(expectedTotalSol.toNumber());
    expect(userAccount.shares.toNumber()).to.equal(expectedUserShares.toNumber());
  });

  it("Withdraw shares and receive SOL", async () => {
    const userPda = getUserPda(provider.wallet.publicKey);
    const sharesToWithdraw = new anchor.BN(300_000_000); // 0.3 worth of shares

    const userBalanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);
    const userAccountBefore = await program.account.userAccount.fetch(userPda);
    const vaultAccountBefore = await program.account.vault.fetch(vaultPda);

    await program.methods
      .withdraw(sharesToWithdraw)
      .accounts({
        vault: vaultPda,
        userAccount: userPda,
        user: provider.wallet.publicKey,
      })
      .rpc();

    const userBalanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);
    const vaultAccount = await program.account.vault.fetch(vaultPda);
    const userAccount = await program.account.userAccount.fetch(userPda);

    // Check vault state updated
    expect(vaultAccount.totalShares.toNumber()).to.equal(
      vaultAccountBefore.totalShares.sub(sharesToWithdraw).toNumber()
    );
    expect(vaultAccount.totalSol.toNumber()).to.equal(
      vaultAccountBefore.totalSol.sub(sharesToWithdraw).toNumber()
    );

    // Check user shares updated
    expect(userAccount.shares.toNumber()).to.equal(
      userAccountBefore.shares.sub(sharesToWithdraw).toNumber()
    );

    // Check user received SOL (accounting for transaction fees)
    expect(userBalanceAfter).to.be.greaterThan(userBalanceBefore);
  });

  it("Cannot withdraw more shares than owned", async () => {
    const userPda = getUserPda(provider.wallet.publicKey);
    const userAccount = await program.account.userAccount.fetch(userPda);
    const tooManyShares = userAccount.shares.add(new anchor.BN(1));

    try {
      await program.methods
        .withdraw(tooManyShares)
        .accounts({
          vault: vaultPda,
          userAccount: userPda,
          user: provider.wallet.publicKey,
        })
        .rpc();
      
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error.message).to.include("InsufficientShares");
    }
  });

  it("Multiple users can deposit and maintain proportional ownership", async () => {
    // Create a second user
    const secondUser = anchor.web3.Keypair.generate();
    const secondUserPda = getUserPda(secondUser.publicKey);

    // Airdrop SOL to second user
    await provider.connection.requestAirdrop(secondUser.publicKey, 2_000_000_000);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for airdrop

    // Create second user account
    await program.methods
      .createUserAccount()
      .accounts({
        userAccount: secondUserPda,
        user: secondUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([secondUser])
      .rpc();

    // Second user deposits
    const secondUserDeposit = new anchor.BN(750_000_000); // 0.75 SOL
    await program.methods
      .deposit(secondUserDeposit)
      .accounts({
        vault: vaultPda,
        userAccount: secondUserPda,
        user: secondUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([secondUser])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    const firstUserAccount = await program.account.userAccount.fetch(getUserPda(provider.wallet.publicKey));
    const secondUserAccount = await program.account.userAccount.fetch(secondUserPda);

    // Verify proportional ownership
    const totalShares = vaultAccount.totalShares.toNumber();
    const firstUserOwnership = firstUserAccount.shares.toNumber() / totalShares;
    const secondUserOwnership = secondUserAccount.shares.toNumber() / totalShares;

    console.log(`First user owns ${(firstUserOwnership * 100).toFixed(2)}% of vault`);
    console.log(`Second user owns ${(secondUserOwnership * 100).toFixed(2)}% of vault`);

    expect(firstUserOwnership + secondUserOwnership).to.be.closeTo(1.0, 0.001);
  });
});