import { PublicKey } from '@solana/web3.js';
import { Client, Token } from '@solflare-wallet/utl-sdk';

export interface TokenMetadata {
  address: string;
  name: string;
  symbol: string;
  logoURI?: string | null;
  decimals: number | null;
  verified?: boolean;
}

class TokenMetadataService {
  private cache: Map<string, TokenMetadata> = new Map();
  private client: Client;

  constructor() {
    this.client = new Client();
  }

  /**
   * Fetch token metadata by mint address
   */
  async getTokenMetadata(mintAddress: string | PublicKey): Promise<TokenMetadata | null> {
    const pubkey = typeof mintAddress === 'string' ? new PublicKey(mintAddress) : mintAddress;
    const address = pubkey.toBase58();

    // Check cache first
    if (this.cache.has(address)) {
      return this.cache.get(address)!;
    }

    try {
      const token = await this.client.fetchMint(pubkey);

      if (token) {
        const metadata: TokenMetadata = {
          address: token.address,
          name: token.name,
          symbol: token.symbol,
          logoURI: token.logoURI,
          decimals: token.decimals,
          verified: token.verified,
        };

        // Cache the result
        this.cache.set(address, metadata);
        return metadata;
      }

      console.warn(`Token metadata not found for mint: ${address}`);
      return null;
    } catch (error) {
      console.error('Error fetching token metadata:', error);
      return null;
    }
  }

  /**
   * Fetch metadata for multiple tokens at once
   * IMPORTANT: Preserves input order by creating a map of address -> metadata
   */
  async getMultipleTokenMetadata(
    mintAddresses: (string | PublicKey)[]
  ): Promise<(TokenMetadata | null)[]> {
    const pubkeys = mintAddresses.map(mint =>
      typeof mint === 'string' ? new PublicKey(mint) : mint
    );

    try {
      const tokens = await this.client.fetchMints(pubkeys);

      // Create a map of address -> metadata to preserve order
      const metadataMap = new Map<string, TokenMetadata>();

      tokens.forEach(token => {
        if (token) {
          const metadata: TokenMetadata = {
            address: token.address,
            name: token.name,
            symbol: token.symbol,
            logoURI: token.logoURI,
            decimals: token.decimals,
            verified: token.verified,
          };

          // Cache the result
          this.cache.set(token.address, metadata);
          metadataMap.set(token.address, metadata);
        }
      });

      // Return results in the same order as input
      return pubkeys.map(pubkey => {
        const address = pubkey.toBase58();
        return metadataMap.get(address) || null;
      });
    } catch (error) {
      console.error('Error fetching multiple token metadata:', error);
      // Fallback to individual fetches (preserves order via Promise.all)
      return Promise.all(mintAddresses.map((mint) => this.getTokenMetadata(mint)));
    }
  }

  /**
   * Clear the cache (useful for testing or force refresh)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// Export a singleton instance
export const tokenMetadataService = new TokenMetadataService();
