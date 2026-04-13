/**
 * x402 facilitator setup — initializes OKX payment infrastructure.
 */

import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  x402ResourceServer,
  x402HTTPResourceServer,
} from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { AggrDeferredEvmScheme } from "@okxweb3/x402-evm/deferred/server";
import { NETWORK, PAY_TO, USDG_ASSET, TOPUP_AMOUNT, TOPUP_USD } from "../config.js";

export interface X402Setup {
  resourceServer: InstanceType<typeof x402ResourceServer>;
  httpServer: InstanceType<typeof x402HTTPResourceServer>;
}

export function createX402Setup(): X402Setup {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;

  if (!apiKey || !secretKey || !passphrase) {
    console.error("Missing OKX API credentials. Set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE.");
    process.exit(1);
  }

  const facilitatorClient = new OKXFacilitatorClient({
    apiKey,
    secretKey,
    passphrase,
    baseUrl: "https://web3.okx.com",
    syncSettle: true,
  });

  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register(NETWORK, new ExactEvmScheme());
  resourceServer.register(NETWORK, new AggrDeferredEvmScheme());

  const topupRoutes = {
    "POST /v1/topup": {
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          price: { asset: USDG_ASSET, amount: TOPUP_AMOUNT },
          maxTimeoutSeconds: 600,
        },
        {
          scheme: "aggr_deferred",
          network: NETWORK,
          payTo: PAY_TO,
          price: { asset: USDG_ASSET, amount: TOPUP_AMOUNT },
          maxTimeoutSeconds: 600,
        },
      ],
      description: `Top up $${TOPUP_USD} USDG — get an API key for Claude API access`,
    },
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, topupRoutes);

  return { resourceServer, httpServer };
}
