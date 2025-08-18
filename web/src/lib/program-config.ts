import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey("Cw3KHMs521Ge3d4xETA6wGwqVNnY7z2xwz6Dtb2Fkp6t");
export const STAKE_POOL_PROGRAM = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");

export const POOLS = [
  {
    name: "BSol",
    stakePool: new PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi"),
    poolMint: new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"),
    reserve: new PublicKey("rsrxDvYUXjH1RQj2Ke36LNZEVqGztATxFkqNukERqFT"),
    withdrawAuthority: new PublicKey("6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2"),
    managerFee: new PublicKey("Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1"),
  },
  {
    name: "haSOL", 
    stakePool: new PublicKey("SAVEY1fVMBeRVo9V9rgEz8ENTvHreftd3QgpAKBDFV4"),
    poolMint: new PublicKey("SAVEDpx3nFNdzG3ymJfShYnrBuYy7LtQEABZQ3qtTFt"),
    reserve: new PublicKey("FL2AsvZPTW33QdmBgQx15ZdtaSbmuwY3oBCJMj63u9W1"),
    withdrawAuthority: new PublicKey("9yWcz4S27nXKpsVmWqaimphCUnFo441JUvwkzmvRWys3"),
    managerFee: new PublicKey("5VyLWq6nGg8mkAsHUwn6KqnaTni6hFZHb6dGiV7dCtGz"),
  }
];

export const ALLOCATIONS = [7000, 3000]; // 70% BSol, 30% haSOL

// PDAs
export const [MINT_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint")],
  PROGRAM_ID
);

export const [VAULT_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault")], 
  PROGRAM_ID
);