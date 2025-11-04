import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY, StakeProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { PROGRAM_ID, STAKE_POOL_PROGRAM, POOLS, ALLOCATIONS, MINT_PDA, VAULT_PDA, VAULT_ID } from './program-config';
import type { StakeBlend } from './stake_blend';
import idl from './stake_blend.json';


export class StakeBlendClient {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private program: anchor.Program<StakeBlend>;

  constructor(connection: Connection, wallet: anchor.Wallet) {
    this.connection = connection;
    this.wallet = wallet;

    // console.log('IDL structure:', idl);
    // console.log('IDL types:', idl.types);
    
    const provider = new anchor.AnchorProvider(connection, wallet, {});
    // Use the typed IDL export instead of JSON
    // this.program = new anchor.Program(
    //   stakeBlendIdl as anchor.Idl, 
    //   PROGRAM_ID, 
    //   provider
    // ) as anchor.Program<StakeBlend>;
    this.program = new anchor.Program<StakeBlend>(
      idl as anchor.Idl,
      provider
    );
  }


  async deposit(amountSOL: number) {
    const userTokenAccount = await getAssociatedTokenAddress(
      MINT_PDA,
      this.wallet.publicKey
    );

    const amount = new anchor.BN(amountSOL * 1e9);

    const remainingAccounts = [];
    for (const pool of POOLS) {
      const vaultPoolTokenAccount = await getAssociatedTokenAddress(
        pool.poolMint,
        VAULT_PDA,
        true
      );

      remainingAccounts.push(
        { pubkey: pool.stakePool, isSigner: false, isWritable: true },
        { pubkey: pool.withdrawAuthority, isSigner: false, isWritable: false },
        { pubkey: pool.reserve, isSigner: false, isWritable: true },
        { pubkey: pool.poolMint, isSigner: false, isWritable: true },
        { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pool.managerFee, isSigner: false, isWritable: true },
        { pubkey: pool.managerFee, isSigner: false, isWritable: true }
      );
    }

    // Check if user's ATA exists
    const accountInfo = await this.connection.getAccountInfo(userTokenAccount);
    const ataExists = accountInfo !== null;

    if (!ataExists) {
      // ATA doesn't exist - build transaction with both createATA and deposit instructions
      const createAtaIx = createAssociatedTokenAccountInstruction(
        this.wallet.publicKey, // payer
        userTokenAccount,       // ata
        this.wallet.publicKey, // owner
        MINT_PDA               // mint
      );

      const depositIx = await this.program.methods
        .deposit(new anchor.BN(VAULT_ID), amount)
        .accounts({
          mint: MINT_PDA,
          vault: VAULT_PDA,
          userVaultTokenAccount: userTokenAccount,
          signer: this.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .instruction();

      const transaction = new Transaction().add(createAtaIx, depositIx);
      return await this.program.provider.sendAndConfirm(transaction);
    } else {
      // ATA exists - use normal flow
      return await this.program.methods
        .deposit(new anchor.BN(VAULT_ID), amount)
        .accounts({
          mint: MINT_PDA,
          vault: VAULT_PDA,
          userVaultTokenAccount: userTokenAccount,
          signer: this.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          stakePoolProgram: STAKE_POOL_PROGRAM,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();
    }
  }

  async withdraw(sharesAmount: number) {
    const userTokenAccount = await getAssociatedTokenAddress(
      MINT_PDA,
      this.wallet.publicKey
    );
    
    const shares = new anchor.BN(sharesAmount * 1e6);

    const remainingAccounts = [];
    for (const pool of POOLS) {
      const vaultPoolTokenAccount = await getAssociatedTokenAddress(
        pool.poolMint,
        VAULT_PDA,
        true
      );

      remainingAccounts.push(
        { pubkey: pool.stakePool, isSigner: false, isWritable: true },
        { pubkey: pool.withdrawAuthority, isSigner: false, isWritable: false },
        { pubkey: pool.reserve, isSigner: false, isWritable: true },
        { pubkey: pool.poolMint, isSigner: false, isWritable: true },
        { pubkey: vaultPoolTokenAccount, isSigner: false, isWritable: true },
        { pubkey: pool.managerFee, isSigner: false, isWritable: true }
      );
    }

    return await this.program.methods
      .withdraw(new anchor.BN(VAULT_ID), shares)
      .accounts({
        mint: MINT_PDA,
        vault: VAULT_PDA,
        userVaultTokenAccount: userTokenAccount,
        signer: this.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        stakePoolProgram: STAKE_POOL_PROGRAM,
        clock: SYSVAR_CLOCK_PUBKEY,
        stakeHistory: SYSVAR_STAKE_HISTORY_PUBKEY,
        stakeProgram: StakeProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  async getUserBalances() {
    const userTokenAccount = await getAssociatedTokenAddress(
      MINT_PDA,
      this.wallet.publicKey
    );

    try {
      const solBalance = await this.connection.getBalance(this.wallet.publicKey);
      const tokenBalance = await this.connection.getTokenAccountBalance(userTokenAccount);
      
      return {
        sol: solBalance / 1e9,
        vaultShares: parseFloat(tokenBalance.value.amount) / 1e6
      };
    } catch (error) {
      return {
        sol: await this.connection.getBalance(this.wallet.publicKey) / 1e9,
        vaultShares: 0
      };
    }
  }
}