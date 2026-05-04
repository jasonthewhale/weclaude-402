/**
 * Refund helper — sends unused USDG back to buyer via onchainos CLI.
 */

import { execSync } from "child_process";
import { PAY_TO, USDG_ASSET } from "../config.js";

export function refundBuyer(
  buyerAddress: string,
  refundUsd: number,
): { success: boolean; output?: string; error?: string } {
  if (refundUsd <= 0) return { success: true, output: "no-refund-needed" };

  // USDG has 6 decimals. Convert USD → atomic units and use --amt to avoid the
  // CLI's decimal-fetch path, which requires an OKX API key.
  const atomic = Math.round(refundUsd * 1_000_000);

  const cmd = [
    "/home/ubuntu/.local/bin/onchainos wallet send",
    `--chain 196`,
    `--from ${PAY_TO}`,
    `--recipient ${buyerAddress}`,
    `--contract-token ${USDG_ASSET}`,
    `--amt ${atomic}`,
    `--force`,
  ].join(" ");

  console.log(`[refund] ${cmd}`);

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
    console.log(`[refund] success: ${output.trim()}`);
    return { success: true, output: output.trim() };
  } catch (err: any) {
    console.error(`[refund] failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
