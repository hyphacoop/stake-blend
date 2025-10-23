import React, { useState, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import * as anchor from '@coral-xyz/anchor';
import { StakeBlendClient } from '../lib/anchor-client';
import { tokenMetadataService, TokenMetadata } from '../lib/token-metadata';
import { POOLS, ALLOCATIONS } from '../lib/program-config';

interface Balances {
  sol: number;
  vaultShares: number;
}

interface PoolWithMetadata {
  poolMint: string;
  allocation: number;
  metadata: TokenMetadata | null;
}

export default function StakeBlendDemo() {
  const { connection } = useConnection();
  const wallet = useWallet();
  
  const [client, setClient] = useState<StakeBlendClient | null>(null);
  const [balances, setBalances] = useState<Balances>({ sol: 0, vaultShares: 0 });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [poolsWithMetadata, setPoolsWithMetadata] = useState<PoolWithMetadata[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(true);

  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');

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

  // Load token metadata on mount
  useEffect(() => {
    const fetchMetadata = async () => {
      setMetadataLoading(true);
      try {
        const metadataList = await tokenMetadataService.getMultipleTokenMetadata(
          POOLS.map(pool => pool.poolMint)
        );

        const poolsData: PoolWithMetadata[] = POOLS.map((pool, index) => ({
          poolMint: pool.poolMint.toBase58(),
          allocation: ALLOCATIONS[index],
          metadata: metadataList[index],
        }));

        setPoolsWithMetadata(poolsData);
      } catch (err) {
        console.error('Error loading token metadata:', err);
      } finally {
        setMetadataLoading(false);
      }
    };

    fetchMetadata();
  }, []);

  const loadBalances = async () => {
    if (!client) return;
    
    try {
      const newBalances = await client.getUserBalances();
      setBalances(newBalances);
    } catch (err) {
      console.error('Failed to load balances:', err);
    }
  };

  const handleInitialize = async () => {
    if (!client) return;
    
    setLoading(true);
    setError('');
    setStatus('Initializing vault...');
    
    try {
      await client.initializeVault();
      setStatus('✅ Vault initialized successfully!');
      await loadBalances();
    } catch (err: any) {
      setError(`Failed to initialize: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAccount = async () => {
    if (!client) return;
    
    setLoading(true);
    setError('');
    setStatus('Creating user account...');
    
    try {
      await client.createUserAccount();
      setStatus('✅ User account created!');
      await loadBalances();
    } catch (err: any) {
      setError(`Failed to create account: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
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
    setStatus(`Depositing ${amount} SOL...`);
    
    try {
      await client.deposit(amount);
      setStatus(`✅ Deposited ${amount} SOL successfully!`);
      setDepositAmount('');
      await loadBalances();
    } catch (err: any) {
      setError(`Failed to deposit: ${err.message}`);
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
    setStatus(`Withdrawing ${shares} shares...`);
    
    try {
      await client.withdraw(shares);
      setStatus(`✅ Withdrew ${shares} shares successfully!`);
      setWithdrawAmount('');
      await loadBalances();
    } catch (err: any) {
      setError(`Failed to withdraw: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (!wallet.connected) {
    return (
      <div className="card">
        <h2>Connect Wallet</h2>
        <WalletMultiButton />
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>Wallet Info</h2>
        <WalletMultiButton />
        <p><strong>SOL Balance:</strong> {balances.sol.toFixed(4)} SOL</p>
        <p><strong>Vault Shares (yes, we messed the decimals up 😭):</strong> {balances.vaultShares.toFixed(6)}</p>
        <button onClick={loadBalances} disabled={loading}>
          🔄 Refresh Balances
        </button>
      </div>

      <div className="card">
        <h2>Setup Functions</h2>
        <p><em>Only needed once for initial setup</em></p>
        {/* <button onClick={handleInitialize} disabled={loading}>
          Initialize Vault
        </button> */}
        <button onClick={handleCreateAccount} disabled={loading}>
          Create User Account
        </button>
      </div>

      <div className="card">
        <h2>Deposit SOL</h2>
        {metadataLoading ? (
          <p>Loading LST information...</p>
        ) : (
          <div>
            <p>Get diversified LST exposure:</p>
            {poolsWithMetadata.map((pool, index) => (
              <div key={pool.poolMint} style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0' }}>
                {pool.metadata?.logoURI && (
                  <img src={pool.metadata.logoURI} alt={pool.metadata.symbol} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                )}
                <span>
                  {pool.allocation / 100}% {pool.metadata?.name || pool.metadata?.symbol || 'Unknown Token'}
                </span>
              </div>
            ))}
          </div>
        )}
        <input
          type="number"
          value={depositAmount}
          onChange={(e) => setDepositAmount(e.target.value)}
          placeholder="Amount in SOL"
          step="0.1"
          min="0"
          disabled={loading}
        />
        <button onClick={handleDeposit} disabled={loading || !depositAmount}>
          💰 Deposit
        </button>
      </div>

      <div className="card">
        <h2>Withdraw</h2>
        <p>Burn vault shares to get SOL back</p>
        <input
          type="number"
          value={withdrawAmount}
          onChange={(e) => setWithdrawAmount(e.target.value)}
          placeholder="Shares to withdraw"
          step="0.1"
          min="0"
          max={balances.vaultShares}
          disabled={loading}
        />
        <button onClick={handleWithdraw} disabled={loading || !withdrawAmount}>
          🏦 Withdraw
        </button>
        <button 
          onClick={() => setWithdrawAmount(balances.vaultShares.toString())}
          disabled={loading || balances.vaultShares === 0}
        >
          Withdraw All
        </button>
      </div>

      {status && (
        <div className="card">
          <h3>Status</h3>
          <p className="success">{status}</p>
        </div>
      )}

      {error && (
        <div className="card">
          <h3>Error</h3>
          <p className="error">{error}</p>
        </div>
      )}

      {loading && (
        <div className="card">
          <p>⏳ Processing transaction...</p>
        </div>
      )}
    </div>
  );
}