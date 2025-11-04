import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey("Cw3KHMs521Ge3d4xETA6wGwqVNnY7z2xwz6Dtb2Fkp6t");
export const STAKE_POOL_PROGRAM = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");

export const POOLS = [
  {
    stakePool: new PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi"),
    poolMint: new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"),
    reserve: new PublicKey("rsrxDvYUXjH1RQj2Ke36LNZEVqGztATxFkqNukERqFT"),
    withdrawAuthority: new PublicKey("6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2"),
    managerFee: new PublicKey("Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1"),
  },
  {
    stakePool: new PublicKey("SAVEY1fVMBeRVo9V9rgEz8ENTvHreftd3QgpAKBDFV4"),
    poolMint: new PublicKey("SAVEDpx3nFNdzG3ymJfShYnrBuYy7LtQEABZQ3qtTFt"),
    reserve: new PublicKey("FL2AsvZPTW33QdmBgQx15ZdtaSbmuwY3oBCJMj63u9W1"),
    withdrawAuthority: new PublicKey("9yWcz4S27nXKpsVmWqaimphCUnFo441JUvwkzmvRWys3"),
    managerFee: new PublicKey("5VyLWq6nGg8mkAsHUwn6KqnaTni6hFZHb6dGiV7dCtGz"),
  }
];

export const ALLOCATIONS = [7000, 3000]; // 70% / 30% split

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
