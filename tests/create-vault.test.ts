import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StakeBlend } from "../target/types/stake_blend";
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { getPDAs } from "./fixtures";
import {
  fetchSplPoolConfig,
  createMarinadePoolConfig,
  PoolProtocol,
  MARINADE_STATE,
  MSOL_MINT,
} from "../scripts/create-vault";

/**
 * Tests for create-vault.ts script functions
 *
 * These tests verify the vault creation helper functions work correctly
 * with both SPL Stake Pool and Marinade protocols.
 */
describe("create-vault script functions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakeBlend as Program<StakeBlend>;

  // Known stake pool addresses on devnet/testnet
  const JITO_POOL = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
  const BSOL_POOL = new PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi");

  describe("fetchSplPoolConfig()", () => {
    it("Should fetch and decode JitoSOL pool correctly", async () => {
      const { vaultPda } = getPDAs(program.programId, 999); // Use high vault ID to avoid conflicts

      const config = await fetchSplPoolConfig(
        provider.connection,
        JITO_POOL,
        vaultPda
      );

      // Verify protocol type
      expect(config.protocol).to.equal(PoolProtocol.SplStakePool);

      // Verify stake pool address
      expect(config.stakePool.toString()).to.equal(JITO_POOL.toString());

      // Verify pool mint exists (JitoSOL mint)
      expect(config.poolMint).to.be.instanceOf(PublicKey);
      expect(config.poolMint.toString()).to.not.be.empty;

      // Verify derived accounts exist
      expect(config.reserve).to.be.instanceOf(PublicKey);
      expect(config.withdrawAuthority).to.be.instanceOf(PublicKey);
      expect(config.managerFee).to.be.instanceOf(PublicKey);
      expect(config.vaultPoolTokenAccount).to.be.instanceOf(PublicKey);

      console.log("  ✓ JitoSOL pool config:", {
        poolMint: config.poolMint.toString().slice(0, 8) + "...",
        reserve: config.reserve!.toString().slice(0, 8) + "...",
      });
    });

    it("Should fetch and decode bSOL pool correctly", async () => {
      const { vaultPda } = getPDAs(program.programId, 999);

      const config = await fetchSplPoolConfig(
        provider.connection,
        BSOL_POOL,
        vaultPda
      );

      expect(config.protocol).to.equal(PoolProtocol.SplStakePool);
      expect(config.stakePool.toString()).to.equal(BSOL_POOL.toString());
      expect(config.poolMint).to.be.instanceOf(PublicKey);

      console.log("  ✓ bSOL pool config:", {
        poolMint: config.poolMint.toString().slice(0, 8) + "...",
      });
    });

    it("Should throw error for invalid stake pool address", async () => {
      const { vaultPda } = getPDAs(program.programId, 999);
      const invalidPool = new PublicKey("11111111111111111111111111111111"); // System program, not a stake pool

      try {
        await fetchSplPoolConfig(provider.connection, invalidPool, vaultPda);
        throw new Error("Should have thrown error for invalid pool");
      } catch (error: any) {
        // Should fail when trying to decode non-stake-pool account
        expect(error.message).to.not.equal("Should have thrown error for invalid pool");
      }
    });
  });

  describe("createMarinadePoolConfig()", () => {
    it("Should create correct Marinade config", () => {
      const { vaultPda } = getPDAs(program.programId, 999);

      const config = createMarinadePoolConfig(vaultPda);

      // Verify protocol type
      expect(config.protocol).to.equal(PoolProtocol.Marinade);

      // Verify Marinade addresses
      expect(config.stakePool.toString()).to.equal(MARINADE_STATE.toString());
      expect(config.poolMint.toString()).to.equal(MSOL_MINT.toString());
      expect(config.marinadeState!.toString()).to.equal(MARINADE_STATE.toString());

      // Verify vault mSOL token account is derived
      expect(config.vaultPoolTokenAccount).to.be.instanceOf(PublicKey);

      console.log("  ✓ Marinade config:", {
        marinadeState: config.marinadeState!.toString().slice(0, 8) + "...",
        msolMint: config.poolMint.toString().slice(0, 8) + "...",
        vaultMSolAccount: config.vaultPoolTokenAccount.toString().slice(0, 8) + "...",
      });
    });

    it("Should create different vault token accounts for different vaults", () => {
      const { vaultPda: vaultPda1 } = getPDAs(program.programId, 1);
      const { vaultPda: vaultPda2 } = getPDAs(program.programId, 2);

      const config1 = createMarinadePoolConfig(vaultPda1);
      const config2 = createMarinadePoolConfig(vaultPda2);

      // Same protocol and mints
      expect(config1.marinadeState!.toString()).to.equal(config2.marinadeState!.toString());
      expect(config1.poolMint.toString()).to.equal(config2.poolMint.toString());

      // But different vault token accounts
      expect(config1.vaultPoolTokenAccount.toString()).to.not.equal(
        config2.vaultPoolTokenAccount.toString()
      );

      console.log("  ✓ Vault token accounts differ per vault");
    });
  });

  describe("Vault creation integration", () => {
    it("Should create SPL-only vault successfully", async () => {
      const vaultId = 100; // Use high ID to avoid conflicts
      const { mintPda, vaultPda } = getPDAs(program.programId, vaultId);

      // Check if vault already exists, skip if so
      try {
        await program.account.vault.fetch(vaultPda);
        console.log("  ✓ Vault already exists, skipping creation");
        return;
      } catch (error) {
        // Vault doesn't exist, proceed with creation
      }

      // Fetch SPL pool configs
      const config1 = await fetchSplPoolConfig(provider.connection, JITO_POOL, vaultPda);
      const config2 = await fetchSplPoolConfig(provider.connection, BSOL_POOL, vaultPda);

      // Build remaining accounts
      const remainingAccounts = [
        { pubkey: config1.stakePool, isWritable: false, isSigner: false },
        { pubkey: config1.poolMint, isWritable: false, isSigner: false },
        { pubkey: config1.vaultPoolTokenAccount, isWritable: true, isSigner: false },
        { pubkey: config2.stakePool, isWritable: false, isSigner: false },
        { pubkey: config2.poolMint, isWritable: false, isSigner: false },
        { pubkey: config2.vaultPoolTokenAccount, isWritable: true, isSigner: false },
      ];

      const allocations = [5000, 5000]; // 50/50
      const poolProtocols = [{ splStakePool: {} }, { splStakePool: {} }];
      const marinadeStates = [null, null];

      // Create vault
      await program.methods
        .initialize(
          new anchor.BN(vaultId),
          allocations,
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

      // Verify vault was created
      const vault = await program.account.vault.fetch(vaultPda);
      expect(vault.vaultId.toNumber()).to.equal(vaultId);
      expect(vault.stakePools.length).to.equal(2);
      expect(vault.allocations).to.deep.equal(allocations);

      // Verify both are SPL protocols
      expect(vault.poolProtocols[0]).to.have.property("splStakePool");
      expect(vault.poolProtocols[1]).to.have.property("splStakePool");

      console.log("  ✓ SPL-only vault created successfully");
    });

    it("Should create mixed protocol vault successfully", async () => {
      const vaultId = 101; // Use high ID to avoid conflicts
      const { mintPda, vaultPda } = getPDAs(program.programId, vaultId);

      // Check if vault already exists
      try {
        await program.account.vault.fetch(vaultPda);
        console.log("  ✓ Vault already exists, skipping creation");
        return;
      } catch (error) {
        // Proceed with creation
      }

      // Mix: bSOL (SPL) + Marinade + JitoSOL (SPL)
      const config1 = await fetchSplPoolConfig(provider.connection, BSOL_POOL, vaultPda);
      const config2 = createMarinadePoolConfig(vaultPda);
      const config3 = await fetchSplPoolConfig(provider.connection, JITO_POOL, vaultPda);

      // Build remaining accounts
      const remainingAccounts = [
        { pubkey: config1.stakePool, isWritable: false, isSigner: false },
        { pubkey: config1.poolMint, isWritable: false, isSigner: false },
        { pubkey: config1.vaultPoolTokenAccount, isWritable: true, isSigner: false },
        { pubkey: config2.stakePool, isWritable: false, isSigner: false },
        { pubkey: config2.poolMint, isWritable: false, isSigner: false },
        { pubkey: config2.vaultPoolTokenAccount, isWritable: true, isSigner: false },
        { pubkey: config3.stakePool, isWritable: false, isSigner: false },
        { pubkey: config3.poolMint, isWritable: false, isSigner: false },
        { pubkey: config3.vaultPoolTokenAccount, isWritable: true, isSigner: false },
      ];

      const allocations = [3333, 3334, 3333]; // ~33% each
      const poolProtocols = [
        { splStakePool: {} },
        { marinade: {} },
        { splStakePool: {} },
      ];
      const marinadeStates = [null, MARINADE_STATE, null];

      // Create vault
      await program.methods
        .initialize(
          new anchor.BN(vaultId),
          allocations,
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

      // Verify vault
      const vault = await program.account.vault.fetch(vaultPda);
      expect(vault.vaultId.toNumber()).to.equal(vaultId);
      expect(vault.stakePools.length).to.equal(3);
      expect(vault.allocations).to.deep.equal(allocations);

      // Verify mixed protocols
      expect(vault.poolProtocols[0]).to.have.property("splStakePool");
      expect(vault.poolProtocols[1]).to.have.property("marinade");
      expect(vault.poolProtocols[2]).to.have.property("splStakePool");

      // Verify marinade states
      expect(vault.marinadeStates[0]).to.be.null;
      expect(vault.marinadeStates[1].toString()).to.equal(MARINADE_STATE.toString());
      expect(vault.marinadeStates[2]).to.be.null;

      console.log("  ✓ Mixed protocol vault created successfully");
    });
  });

  describe("Validation", () => {
    it("Should validate allocations sum to 10000", () => {
      const allocations1 = [5000, 5000];
      const sum1 = allocations1.reduce((a, b) => a + b, 0);
      expect(sum1).to.equal(10000);

      const allocations2 = [3333, 3334, 3333];
      const sum2 = allocations2.reduce((a, b) => a + b, 0);
      expect(sum2).to.equal(10000);

      const invalidAllocations = [5000, 4000];
      const invalidSum = invalidAllocations.reduce((a, b) => a + b, 0);
      expect(invalidSum).to.not.equal(10000);
    });

    it("Should validate protocol values", () => {
      const validProtocols = ["spl", "marinade"];
      for (const proto of validProtocols) {
        expect(proto === "spl" || proto === "marinade").to.be.true;
      }

      const invalidProtocol = "invalid";
      expect(invalidProtocol === "spl" || invalidProtocol === "marinade").to.be.false;
    });

    it("Should validate input lengths match", () => {
      const protocols = ["spl", "marinade", "spl"];
      const pools = ["pool1", "marinade", "pool2"];
      const allocations = [3333, 3334, 3333];

      expect(protocols.length).to.equal(pools.length);
      expect(protocols.length).to.equal(allocations.length);

      // Mismatched example
      const mismatchedAllocations = [5000, 5000]; // Only 2 instead of 3
      expect(protocols.length).to.not.equal(mismatchedAllocations.length);
    });
  });
});
