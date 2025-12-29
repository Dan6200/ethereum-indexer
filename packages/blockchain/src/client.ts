import { createPublicClient, http, fallback, PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { ValidatedTransaction } from "@app/schemas";

interface ProviderConfig {
  url: string;
}

class ReliableProviderManager {
  private providers: ProviderConfig[];
  private unhealthyProviders: Set<string> = new Set();
  private blockHeights: Map<string, number> = new Map();
  // We keep a reference to the monitoring interval to prevent process hanging (optional cleanup)
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(providers: ProviderConfig[]) {
    this.providers = providers;
    if (this.providers.length === 0) {
      console.warn(
        "[WARN] No RPC_URLS provided. Defaulting to Cloudflare (not recommended for production).",
      );
      this.providers.push({ url: "https://cloudflare-eth.com" });
    }
    // Start the background health monitor
    this.monitorHealth();
  }

  private async monitorHealth() {
    // Initial check immediately
    await this.checkProviders();

    this.monitorInterval = setInterval(async () => {
      await this.checkProviders();
    }, 10000); // Check every 10 seconds
  }

  private async checkProviders() {
    let maxHeight = 0;

    // 1. Fetch current block height from all providers
    for (const p of this.providers) {
      try {
        // We create a temporary client just for this check
        const client = createPublicClient({
          chain: mainnet,
          transport: http(p.url),
        });
        const height = Number(await client.getBlockNumber());
        this.blockHeights.set(p.url, height);
        if (height > maxHeight) maxHeight = height;
      } catch (e) {
        // If we can't even connect or get block number, it's unhealthy
        this.unhealthyProviders.add(p.url);
      }
    }

    // 2. Mark providers as unhealthy if they lag by more than 3 blocks (Stale Data Check)
    const STALE_THRESHOLD = 3;
    for (const p of this.providers) {
      // If it already failed connection (in loop above), skip logic, it's already in unhealthy set
      if (!this.blockHeights.has(p.url)) {
        this.unhealthyProviders.add(p.url);
        continue;
      }

      const height = this.blockHeights.get(p.url) || 0;

      // If connection succeeded but it is stale
      if (maxHeight - height > STALE_THRESHOLD) {
        if (!this.unhealthyProviders.has(p.url)) {
          console.warn(
            `[Reliability Layer] Provider ${p.url} is stale (${maxHeight - height} blocks behind). Flagging...`,
          );
        }
        this.unhealthyProviders.add(p.url);
      } else {
        // If it was unhealthy but now caught up, recover it
        if (this.unhealthyProviders.has(p.url)) {
          console.log(`[Reliability Layer] Provider ${p.url} recovered.`);
          this.unhealthyProviders.delete(p.url);
        }
      }
    }
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

// Parse env vars
const rpcUrls = (process.env.RPC_URLS || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const providerConfigs = rpcUrls.map((url) => ({ url }));

// Singleton Export
const manager = new ReliableProviderManager(providerConfigs);

export function getClient(): PublicClient {
  return manager.getClient();
}

/**
 * Fetches just the block header (lightweight) for re-org checks.
 */
export async function fetchBlockHeader(blockNumber: number) {
  const client = getClient();
  return await client.getBlock({ blockNumber: BigInt(blockNumber) });
}

/**
 * Fetches a block and all its transactions, transforming them into our schema format.
 */
export async function fetchBlockData(
  blockNumber: number,
): Promise<ValidatedTransaction[]> {
  const client = getClient();

  try {
    const block = await client.getBlock({
      blockNumber: BigInt(blockNumber),
      includeTransactions: true,
    });

    const validatedTxs: ValidatedTransaction[] = [];

    for (const tx of block.transactions) {
      if (typeof tx === "string") continue;

      validatedTxs.push({
        blockNumber: Number(block.number),
        blockHash: block.hash!,
        transactionHash: tx.hash,
        transactionIndex: Number(tx.transactionIndex),
        from: tx.from,
        to: tx.to || undefined,
        amount: tx.value.toString(),
        isInternalCall: false,
      });
    }

    return validatedTxs;
  } catch (error) {
    console.error(`Error fetching block ${blockNumber}:`, error);
    throw error;
  }
}
