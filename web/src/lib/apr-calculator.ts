import { Connection, PublicKey } from '@solana/web3.js';
import { StakePool, StakePoolLayout } from '@solana/spl-stake-pool';
import BN from 'bn.js';
import Decimal from 'decimal.js';

/**
 * APR calculation result with metadata
 */
export interface APRResult {
  apr: number; // Decimal format (e.g., 0.072 for 7.2%)
  epochYield: number;
  currentEpoch: BN;
  lastUpdateEpoch: BN;
  calculatedAt: number; // Timestamp
}

/**
 * Cache entry for APR data
 */
interface CacheEntry {
  result: APRResult;
  expiresAt: number;
}

/**
 * APR Calculator for SPL Stake Pools
 * Implements the foundational on-chain APR calculation method
 */
export class APRCalculator {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly EPOCHS_PER_YEAR = 160; // Conservative estimate

  constructor(
    private connection: Connection,
    cacheTTL?: number
  ) {
    if (cacheTTL) {
      this.CACHE_TTL_MS = cacheTTL;
    }
  }

  /**
   * Calculate APR for a stake pool using on-chain data
   *
   * Uses the historical snapshot method:
   * 1. Fetch StakePool account data
   * 2. Deserialize using SPL SDK
   * 3. Calculate epoch yield from ratio change
   * 4. Annualize to get APR
   */
  async calculateAPR(stakePoolAddress: PublicKey): Promise<APRResult | null> {
    const addressKey = stakePoolAddress.toBase58();

    // Check cache first
    const cached = this.cache.get(addressKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }

    try {
      // Step 1: Fetch account data and current epoch
      const [accountInfo, epochInfo] = await Promise.all([
        this.connection.getAccountInfo(stakePoolAddress),
        this.connection.getEpochInfo(),
      ]);

      if (!accountInfo || !accountInfo.data) {
        console.warn(`StakePool account not found: ${addressKey}`);
        return null;
      }

      // Step 2: Deserialize using SPL SDK
      const stakePool = StakePoolLayout.decode(accountInfo.data);

      // Step 3: Calculate APR
      const result = this.computeAPR(stakePool, epochInfo.epoch);

      // Cache the result
      if (result) {
        this.cache.set(addressKey, {
          result,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        });
      }

      return result;
    } catch (error) {
      console.error(`Error calculating APR for ${addressKey}:`, error);
      return null;
    }
  }

  /**
   * Calculate APR from deserialized StakePool data
   */
  private computeAPR(stakePool: StakePool, currentEpoch: number): APRResult | null {
    const {
      totalLamports,
      poolTokenSupply,
      lastEpochPoolTokenSupply,
      lastEpochTotalLamports,
      lastUpdateEpoch,
    } = stakePool;

    // Validate we have the data we need
    if (
      poolTokenSupply.isZero() ||
      lastEpochPoolTokenSupply.isZero() ||
      totalLamports.isZero() ||
      lastEpochTotalLamports.isZero()
    ) {
      return null;
    }

    // Calculate epoch yield using Decimal.js for arbitrary precision
    // Formula: epochYield = (currentRatio / previousRatio) - 1
    // Where: currentRatio = totalLamports / poolTokenSupply
    //        previousRatio = lastEpochTotalLamports / lastEpochPoolTokenSupply

    // Convert BN to Decimal
    const totalLamportsDec = new Decimal(totalLamports.toString());
    const poolTokenSupplyDec = new Decimal(poolTokenSupply.toString());
    const lastEpochTotalLamportsDec = new Decimal(lastEpochTotalLamports.toString());
    const lastEpochPoolTokenSupplyDec = new Decimal(lastEpochPoolTokenSupply.toString());

    // Calculate ratios
    const currentRatio = totalLamportsDec.div(poolTokenSupplyDec);
    const previousRatio = lastEpochTotalLamportsDec.div(lastEpochPoolTokenSupplyDec);

    // Calculate epoch yield
    const epochYield = currentRatio.div(previousRatio).minus(1).toNumber();

    // Annualize the yield
    const apr = epochYield * this.EPOCHS_PER_YEAR;

    // Debug logging
    console.log('=== APR Calculation Debug ===');
    console.log('StakePool Data (full struct):');
    console.log(stakePool);
    console.log('\nEpoch Info:');
    console.log('  currentEpoch:', currentEpoch);
    console.log('  lastUpdateEpoch:', lastUpdateEpoch.toString());
    console.log('  epochs behind:', currentEpoch - lastUpdateEpoch.toNumber());
    console.log('\nRaw Values (BN):');
    console.log('  totalLamports:', totalLamports.toString());
    console.log('  poolTokenSupply:', poolTokenSupply.toString());
    console.log('  lastEpochTotalLamports:', lastEpochTotalLamports.toString());
    console.log('  lastEpochPoolTokenSupply:', lastEpochPoolTokenSupply.toString());
    console.log('\nCalculated Ratios:');
    console.log('  currentRatio (SOL per token):', currentRatio.toString());
    console.log('  previousRatio (SOL per token):', previousRatio.toString());
    console.log('  ratio change:', currentRatio.div(previousRatio).toString());
    console.log('\nYield Calculation:');
    console.log('  epochYield:', epochYield);
    console.log('  epochsPerYear:', this.EPOCHS_PER_YEAR);
    console.log('  APR:', apr, `(${(apr * 100).toFixed(4)}%)`);
    console.log('==============================\n');

    return {
      apr,
      epochYield,
      currentEpoch: new BN(currentEpoch),
      lastUpdateEpoch,
      calculatedAt: Date.now(),
    };
  }

  /**
   * Calculate APRs for multiple stake pools in parallel
   */
  async calculateMultipleAPRs(
    stakePoolAddresses: PublicKey[]
  ): Promise<(APRResult | null)[]> {
    return Promise.all(
      stakePoolAddresses.map((address) => this.calculateAPR(address))
    );
  }

  /**
   * Calculate weighted average APR for a vault
   *
   * @param aprs - Array of APR values (can include null)
   * @param allocations - Array of allocation basis points (10000 = 100%)
   */
  calculateWeightedAPR(
    aprs: (APRResult | null)[],
    allocations: number[]
  ): number | null {
    if (aprs.length !== allocations.length) {
      console.error('APRs and allocations arrays must have same length');
      return null;
    }

    let totalWeight = 0;
    let weightedSum = 0;

    for (let i = 0; i < aprs.length; i++) {
      const aprResult = aprs[i];
      const allocation = allocations[i];

      if (aprResult && aprResult.apr > 0) {
        const weight = allocation / 10000; // Convert basis points to decimal
        weightedSum += aprResult.apr * weight;
        totalWeight += weight;
      }
    }

    if (totalWeight === 0) {
      return null;
    }

    return weightedSum;
  }

  /**
   * Clear the APR cache
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
 * Format APR as percentage string
 */
export function formatAPR(apr: number | null): string {
  if (apr === null || apr === undefined) {
    return 'N/A';
  }

  // Convert to percentage and format to 2 decimal places
  const percentage = apr * 100;
  return `${percentage.toFixed(2)}%`;
}

/**
 * Singleton instance for convenience
 */
let defaultCalculator: APRCalculator | null = null;

export function getDefaultAPRCalculator(connection: Connection): APRCalculator {
  if (!defaultCalculator) {
    defaultCalculator = new APRCalculator(connection);
  }
  return defaultCalculator;
}
