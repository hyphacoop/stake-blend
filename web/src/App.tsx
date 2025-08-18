import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import StakeBlendDemo from './components/StakeBlendDemo';

// Default styles for wallet adapter
import '@solana/wallet-adapter-react-ui/styles.css';

export default function App() {
  const network = WalletAdapterNetwork.Mainnet;
  const endpoint = useMemo(() => "https://solana-rpc.publicnode.com", []);
  
  const wallets = useMemo(
    () => [new PhantomWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div>
            <h1>🥩 Stake Blend Demo</h1>
            <p>Deposit SOL to get diversified liquid staking exposure (70% BSol + 30% saveSOL)</p>
            <StakeBlendDemo />
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
