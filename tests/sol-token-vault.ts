import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolTokenVault } from "../target/types/sol_token_vault";
import { expect } from "chai";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

describe("sol-token-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolTokenVault as Program<SolTokenVault>;
  
  // Real stake pool addresses. These are for bSOL on mainnet.
  const STAKE_POOL = new anchor.web3.PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi");
  const MINT = new anchor.web3.PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1");
  const RESERVE = new anchor.web3.PublicKey("rsrxDvYUXjH1RQj2Ke36LNZEVqGztATxFkqNukERqFT");
  const WITHDRAW_AUTHORITY = new anchor.web3.PublicKey("6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2");
  const MANAGER_FEE = new anchor.web3.PublicKey("Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1");
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

  // Vault's pool token account
  const vaultPoolTokenAccount = getAssociatedTokenAddressSync(
    MINT,
    vaultPda,
    true // allowOwnerOffCurve for PDA
  );
  it("Initialize vault", async () => {
    await program.methods
      .initialize()
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        poolMint0: MINT,
        vaultPoolTokenAccount0: vaultPoolTokenAccount,
        signer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .rpc();

    console.log("Vault initialized");
  });

  it("Create user account", async () => {
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

    await program.methods
      .deposit(depositAmount)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        stakePool: STAKE_POOL,
        withdrawAuthority: WITHDRAW_AUTHORITY,
        reserveStakeAccount: RESERVE,
        poolMint: MINT,
        vaultPoolTokenAccount: vaultPoolTokenAccount,
        managerFeeAccount: MANAGER_FEE,
        referrerFeeAccount: MANAGER_FEE, // Can be same as manager
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
      })
      .rpc();

    // Check user received vault shares
    const userBalance = await provider.connection.getTokenAccountBalance(userTokenAccount);
    console.log("User vault shares:", userBalance.value.amount);

    // Check vault received pool tokens
    const vaultPoolBalance = await provider.connection.getTokenAccountBalance(vaultPoolTokenAccount);
    console.log("Vault pool tokens:", vaultPoolBalance.value.amount);
  });

  it("Withdraw shares for SOL", async () => {
    const userTokenAccount = getAssociatedTokenAddressSync(
      mintPda,
      provider.wallet.publicKey
    );

    const sharesToWithdraw = new anchor.BN(500_000_000); // 0.5 vault shares

    const userSolBefore = await provider.connection.getBalance(provider.wallet.publicKey);

    await program.methods
      .withdraw(sharesToWithdraw)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
        userVaultTokenAccount: userTokenAccount,
        signer: provider.wallet.publicKey,
        stakePool: STAKE_POOL,
        withdrawAuthority: WITHDRAW_AUTHORITY,
        reserveStakeAccount: RESERVE,
        poolMint: MINT,
        vaultPoolTokenAccount: vaultPoolTokenAccount,
        managerFeeAccount: MANAGER_FEE,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
        stakeProgram: anchor.web3.StakeProgram.programId,
      })
      .rpc();

    const userSolAfter = await provider.connection.getBalance(provider.wallet.publicKey);
    console.log("SOL received:", (userSolAfter - userSolBefore) / 1e9);
  });
});
