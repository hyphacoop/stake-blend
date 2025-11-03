import { PublicKey } from '@solana/web3.js';
import {
  fetchCSVLink,
  getPriceRangeFromPeriod,
  calcYield,
  PERIOD,
  type PriceRecord
} from '@glitchful-dev/sol-apy-sdk';
import { parse } from 'csv-parse/sync';

// Re-export PERIOD for external use
export { PERIOD };

/**
 * Browser-compatible CSV fetching and parsing
 * SDK's fetchPricesFromCsv uses Node.js streams, so we reimplement for browser
 */
async function fetchPricesForBrowser(stakePoolAddress: string): Promise<PriceRecord[]> {
  // Get the CSV URL from the SDK (uses SDK's built-in pool mapping)
  const csvUrl = fetchCSVLink(stakePoolAddress);

  // Fetch using browser's native fetch
  const response = await fetch(csvUrl);
  const csvText = await response.text();

  // Parse CSV using csv-parse/sync (browser-compatible)
  const rows = parse(csvText, { delimiter: ',', columns: true });

  // Transform rows to PriceRecord format
  const records: PriceRecord[] = [];
  for (const row of rows) {
    const { timestamp, epoch, price } = row;

    if (!timestamp || !epoch || !price) {
      throw new Error('Columns "timestamp", "epoch", "price" must be present!');
    }

    const record: PriceRecord = {
      timestamp: Math.round(new Date(timestamp).getTime() / 1000), // SDK uses seconds
      epoch: Number(epoch),
      price: Number(price),
    };

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
  stakePool: string; // Stake pool address
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
 * Default period for APY calculation (30 days)
 */
const DEFAULT_PERIOD = PERIOD.DAYS_30;

/**
 * APY Service using glitchful-dev/sol-apy-sdk
 *
 * Fetches APY data from GitHub CSV files for 80+ supported LSTs.
 * Uses the SDK's built-in price fetching and yield calculation functions.
 * Returns 0% APY for unsupported LSTs.
 */
export class APYService {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Get APY for a specific stake pool
   *
   * @param stakePoolAddress - Stake pool address
   * @param period - Optional period for calculation (defaults to 30 days)
   * @returns APY result or null if failed
   */
  async getLSTAPY(
    stakePoolAddress: PublicKey | string,
    period: PERIOD = DEFAULT_PERIOD
  ): Promise<LSTAPYResult | null> {
    const stakePool = stakePoolAddress.toString();

    // Check cache first
    const cached = this.cache.get(stakePool);
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`[APY Service] Cache hit: ${stakePool}`);
      return cached.data;
    }

    try {
      console.log(`[APY Service] Fetching APY for stake pool ${stakePool} using ${period}s period`);

      // Fetch price data from CSV (browser-compatible version)
      const prices = await fetchPricesForBrowser(stakePool);

      // Get price range for the specified period
      const priceRange = getPriceRangeFromPeriod(prices, period);

      if (!priceRange) {
        console.error(`[APY Service] No price data available for stake pool ${stakePool} in the specified period`);
        return null;
      }

      // Calculate APY and APR using SDK's calcYield
      const { apy, apr } = calcYield(priceRange);

      // SDK returns APY and APR as decimals (e.g., 0.0671 for 6.71%)
      const result: LSTAPYResult = {
        stakePool,
        apy,
        apr,
        calculatedAt: Date.now(),
        supported: true,
      };

      console.log(
        `[APY Service] Stake pool ${stakePool}: APY ${(result.apy * 100).toFixed(2)}%, APR ${(result.apr * 100).toFixed(2)}%`
      );

      // Cache the result
      this.cache.set(stakePool, {
        data: result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      return result;
    } catch (error) {
      console.error(`[APY Service] Error fetching APY for stake pool ${stakePool}:`, error);

      // Return 0% APY on error (likely unsupported pool)
      const result: LSTAPYResult = {
        stakePool,
        apy: 0,
        apr: 0,
        calculatedAt: Date.now(),
        supported: false,
      };

      // Cache the zero result
      this.cache.set(stakePool, {
        data: result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      return result;
    }
  }

  /**
   * Get APY data for multiple stake pools in parallel
   *
   * @param stakePoolAddresses - Array of stake pool addresses
   */
  async getMultipleLSTAPY(
    stakePoolAddresses: (PublicKey | string)[]
  ): Promise<(LSTAPYResult | null)[]> {
    return Promise.all(
      stakePoolAddresses.map((stakePool) => this.getLSTAPY(stakePool))
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
          console.warn(`[APY Service] Including unsupported stake pool ${result.stakePool} with 0% APY in weighted average`);
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
