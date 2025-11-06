import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey("Cw3KHMs521Ge3d4xETA6wGwqVNnY7z2xwz6Dtb2Fkp6t");
export const STAKE_POOL_PROGRAM = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");

export const POOLS = [
  {
    stakePool: new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"),
    poolMint: new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
    reserve: new PublicKey("BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL"),
    withdrawAuthority: new PublicKey("6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS"),
    managerFee: new PublicKey("feeeFLLsam6xZJFc6UQFrHqkvVt4jfmVvi2BRLkUZ4i"),
  },
  {
    stakePool: new PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi"),
    poolMint: new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"),
    reserve: new PublicKey("rsrxDvYUXjH1RQj2Ke36LNZEVqGztATxFkqNukERqFT"),
    withdrawAuthority: new PublicKey("6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2"),
    managerFee: new PublicKey("Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1"),
  },
];

export const ALLOCATIONS = [5000, 5000]; // 50% / 50% split

// Vault ID - Change this to interact with different vaults
// Vault 0 = existing mainnet vault (bSOL + SaveSOL)
// Vault 1+ = new vaults with different token configurations
export const VAULT_ID = 0;

// Helper to convert vault ID to bytes for PDA derivation
function vaultIdToBytes(vaultId: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(vaultId));
  return buffer;
}

// PDAs
export const [MINT_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint"), vaultIdToBytes(VAULT_ID)],
  PROGRAM_ID
);

export const [VAULT_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), vaultIdToBytes(VAULT_ID)],
  PROGRAM_ID
);
