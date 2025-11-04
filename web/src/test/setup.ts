import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock Solana wallet adapter
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: vi.fn(),
  useConnection: vi.fn(),
  WalletProvider: ({ children }: any) => children,
  ConnectionProvider: ({ children }: any) => children,
}));

// Add global test utilities here if needed
