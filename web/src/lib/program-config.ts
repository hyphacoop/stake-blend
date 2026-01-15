import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey("Cw3KHMs521Ge3d4xETA6wGwqVNnY7z2xwz6Dtb2Fkp6t");

// Vault ID - Change this to interact with different vaults
// Vault configurations are stored on-chain and queried dynamically
// Vault 2: 35% mSOL + 35% JitoSOL + 30% bSOL
export const VAULT_ID = 2;
