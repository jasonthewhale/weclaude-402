export const NETWORK = "eip155:196" as const; // X Layer
export const PAY_TO = process.env.SELLER_ADDRESS || "0x15df42a6ae23a4748c2a06e2bbe1e1bfaa525501";
export const PORT = 4021;

// USDG on X Layer (6 decimals)
export const USDG_ASSET = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";

// Topup: $0.10 USDG = 100_000 atomic units
export const TOPUP_AMOUNT = "100000";
export const TOPUP_USD = 0.1;

// Minimum balance required to attempt an API call (pre-flight sanity check).
// Actual cost is deducted after the call based on real token usage.
export const MIN_BALANCE_USD = 0.0001;
