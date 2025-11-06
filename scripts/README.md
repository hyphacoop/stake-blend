# Vault Creation Script

This script allows you to create new stake-blend vaults on Solana programmatically.

## Prerequisites

1. Build the program first:
   ```bash
   anchor build
   ```

2. Set up your Solana wallet and RPC:
   ```bash
   export ANCHOR_WALLET=~/.config/solana/id.json
   export ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com
   # or use devnet/localhost as needed
   ```

## Usage

```bash
npm run create-vault <vault_id> <pool_addresses> <allocations>
```

Or directly with ts-node:

```bash
ts-node scripts/create-vault.ts <vault_id> <pool_addresses> <allocations>
```

### Parameters

- **vault_id**: Unique numeric identifier for the vault (e.g., 0, 1, 2...)
- **pool_addresses**: Comma-separated list of SPL Stake Pool addresses
- **allocations**: Comma-separated list of allocation basis points (must sum to 10000)

### Examples

#### Create a 50/50 JitoSOL and bSOL vault:

```bash
npm run create-vault 1 \
  "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb,stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi" \
  "5000,5000"
```

#### Create a 30/40/30 three-pool vault:

```bash
npm run create-vault 2 \
  "Pool1Address...,Pool2Address...,Pool3Address..." \
  "3000,4000,3000"
```

## What the Script Does

1. **Validates inputs**: Ensures allocations sum to exactly 10000 (100%)
2. **Queries stake pools**: Fetches on-chain data from each stake pool to derive:
   - Pool mint addresses
   - Reserve stake accounts
   - Manager fee accounts
   - Withdraw authorities (PDAs)
3. **Creates vault**: Sends initialize instruction with all derived accounts
4. **Outputs results**: Displays created vault details including PDAs

## After Creation

Once a vault is created:

1. The vault configuration is stored **on-chain** in the vault account
2. No need to hardcode pool addresses anywhere
3. Frontend/tests should query the vault account to get pool configuration
4. Update your frontend's `VAULT_ID` in `web/src/lib/program-config.ts`

## Common Stake Pool Addresses (Mainnet)

- **JitoSOL**: `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`
- **bSOL (Blaze)**: `stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi`
- **mSOL (Marinade)**: `8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC`
- **scnSOL (Socean)**: `5oc4nmbNTda9fx8Tw57ShLD132aqDK65vuHH4RU1K4LZ`

You can find more stake pools at:
- [Solana Beach Validators](https://solanabeach.io/validators)
- [StakeView](https://stakeview.app/)

## Troubleshooting

### Error: "Allocations must sum to 10000"

Allocations are in basis points (100 basis points = 1%). Make sure they sum to exactly 10000:
- 50/50 split: `5000,5000`
- 30/70 split: `3000,7000`
- 33.33/33.33/33.34 split: `3333,3333,3334`

### Error: "Vault already exists"

The vault ID is already in use. Choose a different vault ID number.

### Error: "Stake pool account not found"

The stake pool address is incorrect or doesn't exist on the network you're connected to. Verify:
1. You're using the correct RPC (mainnet vs devnet)
2. The stake pool address is correct

## Technical Details

### Vault Account Structure

```rust
pub struct Vault {
    pub vault_id: u64,
    pub stake_pools: Vec<Pubkey>,    // Max 10 pools
    pub pool_mints: Vec<Pubkey>,     // LST token mints
    pub allocations: Vec<u16>,       // Basis points (10000 = 100%)
    pub total_shares_issued: u64,
    pub bump: u8,
}
```

### PDAs Used

- **Vault PDA**: `seeds = ["vault", vault_id]`
- **Mint PDA**: `seeds = ["mint", vault_id]` (vault share token)
- **Pool Token Accounts**: ATAs owned by vault PDA for each pool mint

### Accounts Created

The script creates:
1. Vault state account (PDA)
2. Vault share token mint (PDA) with 9 decimals
3. Associated token accounts for each pool mint (owned by vault)
