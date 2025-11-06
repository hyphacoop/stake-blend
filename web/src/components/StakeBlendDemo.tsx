import React, { useState, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { StakeBlendClient } from '../lib/anchor-client';
import { tokenMetadataService, TokenMetadata } from '../lib/token-metadata';
import { APYService, LSTAPYResult, formatAPY } from '../lib/apy-service';

interface Balances {
  sol: number;
  vaultShares: number;
}

interface PoolWithMetadata {
  poolMint: string;
  allocation: number;
  metadata: TokenMetadata | null;
  apy: LSTAPYResult | null;
}

export default function StakeBlendDemo() {
  const { connection } = useConnection();
  const wallet = useWallet();
  
  const [client, setClient] = useState<StakeBlendClient | null>(null);
  const [balances, setBalances] = useState<Balances>({ sol: 0, vaultShares: 0 });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [txSignature, setTxSignature] = useState<string>('');
  const [poolsWithMetadata, setPoolsWithMetadata] = useState<PoolWithMetadata[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [aggregateAPY, setAggregateAPY] = useState<number | null>(null);

  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [refreshCountdown, setRefreshCountdown] = useState(10);

  // Initialize client when wallet connects
  useEffect(() => {
    if (wallet.publicKey && wallet.signTransaction && wallet.signAllTransactions) {
      const anchorWallet = {
        publicKey: wallet.publicKey,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions,
      };
      setClient(new StakeBlendClient(connection, anchorWallet));
    } else {
      setClient(null);
    }
  }, [wallet, connection]);

  // Load balances when client is ready
  useEffect(() => {
    if (client) {
      loadBalances();
    }
  }, [client]);

  // Auto-refresh balances with countdown timer
  useEffect(() => {
    if (!client) return;

    const countdownInterval = setInterval(() => {
      setRefreshCountdown((prev) => {
        if (prev <= 1) {
          loadBalances();
          return 10;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, [client]);

  // Load vault data, token metadata and APYs on mount
  useEffect(() => {
    const fetchMetadataAndAPYs = async () => {
      if (!client) return;

      setMetadataLoading(true);
      try {
        // Fetch vault data from on-chain
        const vaultData = await client.getVaultData();
        const poolAccounts = await client.getPoolAccountsPublic();

        // Create APY service
        const apyService = new APYService();

        // Fetch metadata and APYs in parallel
        const [metadataList, apyList] = await Promise.all([
          tokenMetadataService.getMultipleTokenMetadata(
            vaultData.poolMints.map((mint: PublicKey) => mint)
          ),
          apyService.getMultipleLSTAPY(
            vaultData.stakePools.map((pool: PublicKey) => pool)
          ),
        ]);

        const poolsData: PoolWithMetadata[] = vaultData.poolMints.map((mint: PublicKey, index: number) => ({
          poolMint: mint.toBase58(),
          allocation: vaultData.allocations[index],
          metadata: metadataList[index],
          apy: apyList[index],
        }));

        setPoolsWithMetadata(poolsData);

        // Calculate weighted aggregate APY
        const weightedAPY = apyService.calculateWeightedAPY(apyList, vaultData.allocations);
        setAggregateAPY(weightedAPY);
      } catch (err) {
        console.error('Error loading vault data, token metadata and APYs:', err);
      } finally {
        setMetadataLoading(false);
      }
    };

    fetchMetadataAndAPYs();
  }, [client]);

  const loadBalances = async () => {
    if (!client) return;
    
    try {
      const newBalances = await client.getUserBalances();
      setBalances(newBalances);
    } catch (err) {
      console.error('Failed to load balances:', err);
    }
  };


  const handleDeposit = async () => {
    if (!client || !depositAmount) return;

    const amount = parseFloat(depositAmount);
    if (isNaN(amount) || amount <= 0) {
      setError('Invalid deposit amount');
      return;
    }

    setLoading(true);
    setError('');
    setTxSignature('');
    setStatus(`Depositing ${amount} SOL...`);

    try {
      const signature = await client.deposit(amount);
      setTxSignature(signature);
      setStatus(`✅ Deposited ${amount} SOL successfully!`);
      setDepositAmount('');
      await loadBalances();
    } catch (err: any) {
      setError(`Failed to deposit: ${err.message}`);
      // Try to extract transaction signature from error if available
      if (err.signature) {
        setTxSignature(err.signature);
      }
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleWithdraw = async () => {
    if (!client || !withdrawAmount) return;

    const shares = parseFloat(withdrawAmount);
    if (isNaN(shares) || shares <= 0) {
      setError('Invalid withdrawal amount');
      return;
    }

    setLoading(true);
    setError('');
    setTxSignature('');
    setStatus(`Withdrawing ${shares} shares...`);

    try {
      const signature = await client.withdraw(shares);
      setTxSignature(signature);
      setStatus(`✅ Withdrew ${shares} shares successfully!`);
      setWithdrawAmount('');
      await loadBalances();
    } catch (err: any) {
      setError(`Failed to withdraw: ${err.message}`);
      // Try to extract transaction signature from error if available
      if (err.signature) {
        setTxSignature(err.signature);
      }
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (!wallet.connected) {
    return (
      <div className="section">
        <div className="section-header">
          <span className="prompt">$</span> wallet.connect
        </div>
        <WalletMultiButton />
      </div>
    );
  }

  return (
    <div>
      {/* Wallet button at top */}
      <div style={{ marginBottom: '1.5rem' }}>
        <WalletMultiButton />
      </div>

      {/* Tab buttons */}
      <div className="tab-group">
        <button
          className={`tab-button ${activeTab === 'deposit' ? 'active' : ''}`}
          onClick={() => setActiveTab('deposit')}
        >
          [+] Deposit
        </button>
        <button
          className={`tab-button ${activeTab === 'withdraw' ? 'active' : ''}`}
          onClick={() => setActiveTab('withdraw')}
        >
          [-] Withdraw
        </button>
      </div>

      {/* Deposit tab content */}
      {activeTab === 'deposit' && (
        <div className="section">
          <div className="section-header">
            <span className="prompt">$</span> stake.deposit
          </div>
          {metadataLoading ? (
            <p style={{fontSize: '0.85rem', color: '#88ff88'}}>Loading LST information...</p>
          ) : (
            <div style={{fontSize: '0.85rem', color: '#88ff88', marginBottom: '1rem'}}>
              <div>Get diversified LST exposure:</div>
              {aggregateAPY !== null && (
                <div style={{ fontSize: '1.1em', fontWeight: 'bold', margin: '8px 0' }}>
                  Vault APY: {formatAPY(aggregateAPY)}
                </div>
              )}
              {poolsWithMetadata.map((pool, index) => (
                <div key={pool.poolMint} style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0' }}>
                  {pool.metadata?.logoURI && (
                    <img src={pool.metadata.logoURI} alt={pool.metadata.symbol} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                  )}
                  <span className="prompt">├──</span>
                  <span>
                    {pool.allocation / 100}% {pool.metadata?.name || pool.metadata?.symbol || 'Unknown Token'}
                    {pool.apy && <span style={{ color: '#4caf50', marginLeft: '8px' }}>({formatAPY(pool.apy.apy)})</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="input-group">
            <label className="input-label">
              <span className="prompt">&gt;</span> Amount in SOL
            </label>
            <div className="input-wrapper">
              <input
                className="terminal-input with-max-button"
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="0.00"
                step="0.1"
                min="0"
                disabled={loading}
              />
              <button
                className="max-button"
                onClick={() => setDepositAmount(balances.sol.toString())}
                disabled={loading || balances.sol === 0}
              >
                [▶▶] MAX
              </button>
            </div>
          </div>
          <div className="button-group">
            <button className="terminal-button primary" onClick={handleDeposit} disabled={loading || !depositAmount}>
              [▶] Execute Deposit
            </button>
          </div>
        </div>
      )}

      {/* Withdraw tab content */}
      {activeTab === 'withdraw' && (
        <div className="section">
          <div className="section-header">
            <span className="prompt">$</span> stake.withdraw
          </div>
          <div style={{fontSize: '0.85rem', color: '#88ff88', marginBottom: '1rem'}}>
            Burn vault shares → Receive proportional SOL from basket
          </div>
          <div className="input-group">
            <label className="input-label">
              <span className="prompt">&gt;</span> Shares to withdraw
            </label>
            <div className="input-wrapper">
              <input
                className="terminal-input with-max-button"
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.000000"
                step="0.1"
                min="0"
                max={balances.vaultShares}
                disabled={loading}
              />
              <button
                className="max-button"
                onClick={() => setWithdrawAmount(balances.vaultShares.toString())}
                disabled={loading || balances.vaultShares === 0}
              >
                [▶▶] MAX
              </button>
            </div>
          </div>
          <div className="button-group">
            <button className="terminal-button warning" onClick={handleWithdraw} disabled={loading || !withdrawAmount}>
              [▶] Execute Withdraw
            </button>
          </div>
        </div>
      )}

      {/* Wallet balance at bottom */}
      <div className="balance-section">
        <div className="balance-section-header">
          <span className="prompt">$</span> wallet.balance
        </div>
        <div className="info-line">
          <span className="label">SOL Balance:</span>
          <span className="value-highlight">{balances.sol.toFixed(4)} SOL</span>
        </div>
        <div className="info-line">
          <span className="label">Vault Shares:</span>
          <span className="value">{balances.vaultShares.toFixed(6)}</span>
        </div>
        <div className="refresh-info">
          <span style={{ fontSize: '0.75rem', color: '#88ff88' }}>
            Auto-refresh in {refreshCountdown}s
          </span>
        </div>
      </div>

      {status && (
        <div className="section">
          <div className="section-header">
            <span className="prompt">$</span> status
          </div>
          <p style={{color: '#33ff33', fontSize: '0.9rem'}}>{status}</p>
          {txSignature && (
            <div style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
              <span style={{ color: '#88ff88' }}>Transaction: </span>
              <a
                href={`https://solscan.io/tx/${txSignature}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: '#33ff33',
                  textDecoration: 'underline',
                  wordBreak: 'break-all'
                }}
              >
                {txSignature.slice(0, 8)}...{txSignature.slice(-8)}
              </a>
              <span style={{ color: '#88ff88', marginLeft: '0.5rem' }}>↗</span>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="section">
          <div className="section-header">
            <span className="prompt">$</span> error
          </div>
          <p style={{color: '#ff3333', fontSize: '0.9rem'}}>{error}</p>
          {txSignature && (
            <div style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
              <span style={{ color: '#88ff88' }}>Transaction: </span>
              <a
                href={`https://solscan.io/tx/${txSignature}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: '#ff3333',
                  textDecoration: 'underline',
                  wordBreak: 'break-all'
                }}
              >
                {txSignature.slice(0, 8)}...{txSignature.slice(-8)}
              </a>
              <span style={{ color: '#ff3333', marginLeft: '0.5rem' }}>↗</span>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="section">
          <p style={{fontSize: '0.9rem'}}>⏳ Processing transaction...</p>
        </div>
      )}
    </div>
  );
}