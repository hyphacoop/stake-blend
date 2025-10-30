import { PublicKey } from '@solana/web3.js';
import { DATA_SOURCE, calcAverageApy } from '@glitchful-dev/sol-apy-sdk';
import { parse } from 'csv-parse/sync';

/**
 * Price record from CSV (matches SDK type)
 */
type PriceRecord = {
  timestamp: number;
  epoch: number;
  price: number;
};

/**
 * Browser-compatible CSV fetching and parsing
 * Replicates SDK's parsePriceRecordsFromCSV logic without Node.js streams
 */
async function fetchAndParsePricesCsv(url: string): Promise<PriceRecord[]> {
  // Fetch CSV text using browser fetch
  const response = await fetch(url);
  const csvText = await response.text();

  // Parse CSV using csv-parse library (same as SDK uses)
  const rows = parse(csvText, { delimiter: ',', columns: true });

  // Transform and validate rows (copied from SDK's parsePriceRecordsFromCSV)
  const records: PriceRecord[] = [];
  for (const row of rows) {
    const { timestamp, epoch, price } = row;

    // Validation (same as SDK)
    if (!timestamp || !epoch || !price) {
      throw new Error('Columns "timestamp", "epoch", "price" must be present!');
    }

    const record: PriceRecord = {
      timestamp: new Date(timestamp).getTime(),
      epoch: Number(epoch),
      price: Number(price),
    };

    // Type validation (same as SDK)
    if (isNaN(record.timestamp)) {
      throw new Error('Timestamp must be a... timestamp!');
    }
    if (isNaN(record.epoch)) {
      throw new Error('Epoch must be a number!');
    }
    if (isNaN(record.price)) {
      throw new Error('Price must be a number!');
    }

    records.push(record);
  }

  return records;
}

/**
 * APY data result
 */
export interface LSTAPYResult {
  mint: string;
  apy: number; // As decimal (e.g., 0.0723 for 7.23%)
  apr: number; // As decimal
  calculatedAt: number; // Timestamp
  supported: boolean; // Whether this LST is supported by the SDK
}

/**
 * Cache entry
 */
interface CacheEntry {
  data: LSTAPYResult;
  expiresAt: number;
}

/**
 * Mapping of mint addresses to DATA_SOURCE constants
 */
const MINT_TO_DATA_SOURCE: Record<string, keyof typeof DATA_SOURCE> = {
  // BlazeStake (bSOL) - uses SOLBLAZE_CSV from SDK
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': 'SOLBLAZE_CSV',

  // Add more as needed:
  // 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'MARINADE_CSV', // Marinade (mSOL)
  // 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'JITO_CSV',      // Jito (jitoSOL)
};

/**
 * APY Service using glitchful-dev/sol-apy-sdk
 *
 * Fetches APY data from GitHub CSV files for supported LSTs.
 * Returns 0% APY for unsupported LSTs.
 */
export class APYService {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Get APY for a specific LST
   *
   * @param mintAddress - LST mint address
   * @returns APY result or null if failed
   */
  async getLSTAPY(mintAddress: PublicKey | string): Promise<LSTAPYResult | null> {
    const mint = mintAddress.toString();

    // Check cache first
    const cached = this.cache.get(mint);
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`[APY Service] Cache hit: ${mint}`);
      return cached.data;
    }

    // Check if this LST is supported
    const dataSourceKey = MINT_TO_DATA_SOURCE[mint];

    if (!dataSourceKey) {
      // LST not supported - return 0% APY
      console.warn(`[APY Service] LST not supported: ${mint} - returning 0% APY`);
      const result: LSTAPYResult = {
        mint,
        apy: 0,
        apr: 0,
        calculatedAt: Date.now(),
        supported: false,
      };

      // Cache the zero result too (no need to keep warning)
      this.cache.set(mint, {
        data: result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      return result;
    }

    try {
      console.log(`[APY Service] Fetching APY for ${mint} using ${dataSourceKey}`);

      // Fetch price data from CSV
      const dataSource = DATA_SOURCE[dataSourceKey];
      const prices = await fetchAndParsePricesCsv(dataSource);

      // Calculate APY using SDK's calcAverageApy (10 epochs lookback ≈ 20-30 days)
      const apy = calcAverageApy(prices, 10);

      if (apy === null) {
        console.error(`[APY Service] Failed to calculate APY for ${mint}`);
        return null;
      }

      // SDK returns APY as decimal (e.g., 0.0671 for 6.71%)
      const result: LSTAPYResult = {
        mint,
        apy: apy,
        apr: apy, // APR ≈ APY for these calculations
        calculatedAt: Date.now(),
        supported: true,
      };

      console.log(`[APY Service] APY for ${mint}: ${(result.apy * 100).toFixed(2)}%`);

      // Cache the result
      this.cache.set(mint, {
        data: result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      return result;
    } catch (error) {
      console.error(`[APY Service] Error fetching APY for ${mint}:`, error);
      return null;
    }
  }

  /**
   * Get APY data for multiple LSTs in parallel
   *
   * @param mintAddresses - Array of LST mint addresses
   */
  async getMultipleLSTAPY(
    mintAddresses: (PublicKey | string)[]
  ): Promise<(LSTAPYResult | null)[]> {
    return Promise.all(
      mintAddresses.map((mint) => this.getLSTAPY(mint))
    );
  }

  /**
   * Calculate weighted average APY for a vault
   *
   * @param apyResults - Array of APY results (can include null)
   * @param allocations - Array of allocation basis points (10000 = 100%)
   */
  calculateWeightedAPY(
    apyResults: (LSTAPYResult | null)[],
    allocations: number[]
  ): number | null {
    if (apyResults.length !== allocations.length) {
      console.error('[APY Service] APY results and allocations arrays must have same length');
      return null;
    }

    let totalWeight = 0;
    let weightedSum = 0;

    for (let i = 0; i < apyResults.length; i++) {
      const result = apyResults[i];
      const allocation = allocations[i];

      if (result) {
        const weight = allocation / 10000; // Convert basis points to decimal
        weightedSum += result.apy * weight;
        totalWeight += weight;

        if (!result.supported) {
          console.warn(`[APY Service] Including unsupported LST ${result.mint} with 0% APY in weighted average`);
        }
      }
    }

    if (totalWeight === 0) {
      return null;
    }

    return weightedSum;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    };
  }
}

/**
 * Format APY as percentage string
 */
export function formatAPY(apy: number | null): string {
  if (apy === null || apy === undefined) {
    return 'N/A';
  }

  // Convert to percentage and format to 2 decimal places
  const percentage = apy * 100;
  return `${percentage.toFixed(2)}%`;
}

/**
 * Singleton instance for convenience
 */
let defaultService: APYService | null = null;

export function getDefaultAPYService(): APYService {
  if (!defaultService) {
    defaultService = new APYService();
  }
  return defaultService;
}
