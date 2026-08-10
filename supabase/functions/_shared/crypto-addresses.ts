// Mirror of deposit wallet info shown in src/components/CryptoPayment.tsx.
// Kept in sync manually — keep both in lockstep when addresses rotate.

export type PayCurrency = "BTC" | "BNB" | "USDT-BEP20" | "USDT-TRC20";

export interface DepositWallet {
  currency: PayCurrency;
  label: string;
  network: string;
  address: string;
}

export const DEPOSIT_WALLETS: Record<PayCurrency, DepositWallet> = {
  "BTC": {
    currency: "BTC",
    label: "Bitcoin",
    network: "Bitcoin Network",
    address: "1EuGLFCfRVd2p4VwpjWHhBKtZbMc8Wbcv7",
  },
  "BNB": {
    currency: "BNB",
    label: "BNB",
    network: "BNB Smart Chain (BEP-20)",
    address: "0x15a62f46355f03b66c30e88dad4564dd69a3aab7",
  },
  "USDT-BEP20": {
    currency: "USDT-BEP20",
    label: "USDT (BEP-20)",
    network: "BNB Smart Chain (BEP-20)",
    address: "0x15a62f46355f03b66c30e88dad4564dd69a3aab7",
  },
  "USDT-TRC20": {
    currency: "USDT-TRC20",
    label: "USDT (TRC20)",
    network: "Tron Network (TRC20)",
    address: "TMzkn5dm1Ehzg5KUF8uNcB1N9Y5FjzadF8",
  },
};
