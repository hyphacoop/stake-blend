import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY, StakeProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import { PROGRAM_ID, VAULT_ID } from './program-config';
import type { StakeBlend } from './stake_blend';
import idl from './stake_blend.json';
import {
  getPDAs,
  fetchAllPoolAccounts,
  buildDepositRemainingAccounts,
  buildWithdrawRemainingAccounts,
  STAKE_POOL_PROGRAM,
  type PoolAccounts,
} from './vault-helpers';


export class StakeBlendClient {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private program: anchor.Program<StakeBlend>;
  private poolAccountsCache: PoolAccounts[] | null = null;
  private vaultId: number;

  constructor(connection: Connection, wallet: anchor.Wallet, vaultId: number = VAULT_ID) {
    this.connection = connection;
    this.wallet = wallet;
    this.vaultId = vaultId;

    const provider = new anchor.AnchorProvider(connection, wallet, {});
    this.program = new anchor.Program<StakeBlend>(
      idl as anchor.Idl,
      provider
    );
  }

  /**
   * Fetch pool accounts from on-chain vault configuration
   * Results are cached to avoid repeated queries
   */
  private async getPoolAccounts(): Promise<PoolAccounts[]> {
    if (this.poolAccountsCache) {
      return this.poolAccountsCache;
    }

    this.poolAccountsCache = await fetchAllPoolAccounts(
      this.connection,
      this.program,
      this.vaultId
    );

    return this.poolAccountsCache;
  }

  /**
   * Clear the pool accounts cache (call if vault configuration changes)
   */
  public clearCache() {
    this.poolAccountsCache = null;
  }


  async deposit(amountSOL: number) {
    const { mintPda, vaultPda } = getPDAs(this.program.programId, this.vaultId);
    const userTokenAccount = await getAssociatedTokenAddress(
      mintPda,
      this.wallet.publicKey
    );

    const amount = new anchor.BN(amountSOL * 1e9);

    // Fetch pool accounts dynamically from on-chain vault
    const poolAccounts = await this.getPoolAccounts();
    const remainingAccounts = buildDepositRemainingAccounts(poolAccounts);

    // Check if user's ATA exists
    const accountInfo = await this.connection.getAccountInfo(userTokenAccount);
    const ataExists = accountInfo !== null;

    if (!ataExists) {
      // ATA doesn't exist - build transaction with both createATA and deposit instructions
      const createAtaIx = await this.program.methods
       .createUserAccount(new anchor.BN(this.vaultId))
       .accounts({
         tokenAccount: userTokenAccount,
         signer: this.wallet.publicKey,
         mint: mintPda,
         systemProgram: anchor.web3.SystemProgram.programId,
         tokenProgram: TOKEN_PROGRAM_ID,
         associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
       }).instruction();

      const depositIx = await this.program.methods
        .deposit(new anchor.BN(this.vaultId), amount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
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
        .deposit(new anchor.BN(this.vaultId), amount)
        .accounts({
          mint: mintPda,
          vault: vaultPda,
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
    const { mintPda, vaultPda } = getPDAs(this.program.programId, this.vaultId);
    const userTokenAccount = await getAssociatedTokenAddress(
      mintPda,
      this.wallet.publicKey
    );

    const shares = new anchor.BN(sharesAmount * 1e9);

    // Fetch pool accounts dynamically from on-chain vault
    const poolAccounts = await this.getPoolAccounts();
    const remainingAccounts = buildWithdrawRemainingAccounts(poolAccounts);

    return await this.program.methods
      .withdraw(new anchor.BN(this.vaultId), shares)
      .accounts({
        mint: mintPda,
        vault: vaultPda,
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
    const { mintPda } = getPDAs(this.program.programId, this.vaultId);
    const userTokenAccount = await getAssociatedTokenAddress(
      mintPda,
      this.wallet.publicKey
    );

    try {
      const solBalance = await this.connection.getBalance(this.wallet.publicKey);
      const tokenBalance = await this.connection.getTokenAccountBalance(userTokenAccount);

      return {
        sol: solBalance / 1e9,
        vaultShares: parseFloat(tokenBalance.value.amount) / 1e9
      };
    } catch (error) {
      return {
        sol: await this.connection.getBalance(this.wallet.publicKey) / 1e9,
        vaultShares: 0
      };
    }
  }

  /**
   * Get vault data including pool configuration and allocations
   */
  async getVaultData() {
    return await this.program.account.vault.fetch(
      getPDAs(this.program.programId, this.vaultId).vaultPda
    );
  }

  /**
   * Get current pool accounts
   */
  async getPoolAccountsPublic() {
    return await this.getPoolAccounts();
  }
}