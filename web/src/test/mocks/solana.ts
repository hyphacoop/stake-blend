import { PublicKey, Connection, Transaction } from '@solana/web3.js';
import { vi } from 'vitest';
import * as anchor from '@coral-xyz/anchor';

export const mockPublicKey = new PublicKey('11111111111111111111111111111111');

export const createMockConnection = () => ({
  getAccountInfo: vi.fn(),
  getBalance: vi.fn(),
  sendTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  getLatestBlockhash: vi.fn(() => Promise.resolve({
    blockhash: 'mock-blockhash',
    lastValidBlockHeight: 1000,
  })),
  getTokenAccountBalance: vi.fn(),
});

export const createMockWallet = () => ({
  publicKey: mockPublicKey,
  signTransaction: vi.fn((tx: Transaction) => Promise.resolve(tx)),
  signAllTransactions: vi.fn((txs: Transaction[]) => Promise.resolve(txs)),
});

export const createMockAnchorWallet = (): anchor.Wallet => {
  return {
    publicKey: mockPublicKey,
    signTransaction: vi.fn((tx: Transaction) => Promise.resolve(tx)),
    signAllTransactions: vi.fn((txs: Transaction[]) => Promise.resolve(txs)),
  };
};
