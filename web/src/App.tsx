import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import StakeBlendDemo from './components/StakeBlendDemo';

// Default styles for wallet adapter
import '@solana/wallet-adapter-react-ui/styles.css';

export default function App() {
  const network = WalletAdapterNetwork.Mainnet;
  const endpoint = useMemo(() => "https://solana-rpc.publicnode.com", []);
  
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="terminal-container">
            <div className="terminal-header">
              <div>
                <div className="terminal-title">
                  <span className="logo-ascii">◈</span>
                  <span>STAKE BLEND</span>
                  <span className="cursor"></span>
                </div>
                <div className="terminal-subtitle">
                  Multi-LST vaults with tokenized shares
                </div>
              </div>
              <div className="terminal-info">
                Solana Mainnet
              </div>
            </div>
            <div className="info-box">
              <span className="prompt">[INFO]</span> Diversified liquid staking exposure through multi-LST vaults | <a href="https://docs.google.com/forms/d/e/1FAIpQLScZzy3-k8A4zpxqhCQT4OF9Diz-mYUfbfAbWSHfg22up9_nWw/viewform?usp=dialog" target="_blank" rel="noopener noreferrer">Feedback please!</a>
            </div>
            <StakeBlendDemo />
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
