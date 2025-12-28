# Custom Transport

Instead of using the default viem `fallback` transport, we create a custom transport. This allows us to intercept every request, check the providers height metadata, and decide whether to route the call or fail over.

## Key Takeaways

1. Hysteresis: The provider has to be healthy for an extended time, as well as waiting for the current node to be quite stale (several blocks behind) to avoid thrashing.
2. Stateful Monitoring: The logic should stay out of the request loop and into a background interval. To avoid blocking of the indexing queries.
3. Type Safety: Run the data returned from the fallback providers to ensure they have not suddenly modified the expected data structure.

```ts
import {
  createPublicClient,
  fallback,
  http,
  PublicClient,
  HttpTransport,
} from "viem";
import { mainnet } from "viem/chains";

/**
 * ARCHITECTURAL NOTE FOR DANIEL:
 * Standard fallbacks only check if the node is "online" (HTTP 200).
 * For an Indexer, an "online" node that is 10 blocks behind is actually "broken."
 * This wrapper demonstrates how to proactively monitor block height.
 */

interface ProviderConfig {
  url: string;
  weight: number;
}

class ReliableProviderManager {
  private providers: ProviderConfig[];
  private unhealthyProviders: Set<string> = new Set();
  private blockHeights: Map<string, number> = new Map();

  constructor(providers: ProviderConfig[]) {
    this.providers = providers;
    // Start the background health monitor
    this.monitorHealth();
  }

  private async monitorHealth() {
    setInterval(async () => {
      let maxHeight = 0;

      // 1. Fetch current block height from all providers
      for (const p of this.providers) {
        try {
          const client = createPublicClient({
            chain: mainnet,
            transport: http(p.url),
          });
          const height = Number(await client.getBlockNumber());
          this.blockHeights.set(p.url, height);
          if (height > maxHeight) maxHeight = height;
        } catch (e) {
          this.unhealthyProviders.add(p.url);
        }
      }

      // 2. Mark providers as unhealthy if they lag by more than 3 blocks (Stale Data Check)
      const STALE_THRESHOLD = 3;
      for (const p of this.providers) {
        const height = this.blockHeights.get(p.url) || 0;
        if (maxHeight - height > STALE_THRESHOLD) {
          console.warn(
            `[Reliability Layer] Provider ${p.url} is stale (${maxHeight - height} blocks behind). Flagging...`,
          );
          this.unhealthyProviders.add(p.url);
        } else {
          this.unhealthyProviders.delete(p.url);
        }
      }
    }, 10000); // Check every 10 seconds
  }

  public getClient(): PublicClient {
    // Filter out the stale/broken providers dynamically
    const activeTransports = this.providers
      .filter((p) => !this.unhealthyProviders.has(p.url))
      .map((p) => http(p.url));

    // Fallback to the first provider if all are "unhealthy" (prevent total crash)
    const finalTransports =
      activeTransports.length > 0
        ? activeTransports
        : [http(this.providers[0].url)];

    return createPublicClient({
      chain: mainnet,
      transport: fallback(finalTransports, { rank: true }),
    });
  }
}

// Usage in your Indexer Daemon
const manager = new ReliableProviderManager([
  {
    url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
    weight: 1,
  },
  { url: `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`, weight: 1 },
  { url: "https://rpc.ankr.com/eth", weight: 1 },
]);

export const client = manager.getClient();
```
