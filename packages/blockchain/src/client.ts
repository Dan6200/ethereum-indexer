import { createPublicClient, http, fallback, PublicClient, Chain } from "viem";
import { mainnet } from "viem/chains";
import { ValidatedTransaction, ValidatedLog } from "@app/schemas";

const debug = process.env.DEBUG_RPC === "1";
const stripSensitiveEndpoints = (url: string) => url.replace(/(?<=.*)\/[^.]+$/, "");

export interface BlockIngestData {
  blockNumber: bigint;
  blockHash: string;
  parentHash: string;
  transactions: ValidatedTransaction[];
  logs: ValidatedLog[];
}

export interface ProviderConfig {
  url: string;
}

interface ProviderEntry {
  url: string;
  client: PublicClient;
}

class ReliableProviderManager {
  private providers: ProviderEntry[];
  private unhealthyProviders: Set<string> = new Set();
  private blockHeights: Map<string, number> = new Map();
  // We keep a reference to the monitoring interval to prevent process hanging (optional cleanup)
  private monitorInterval: NodeJS.Timeout | null = null;
  private cachedClient: PublicClient | null = null;
  private cachedClientKey = "";
  private chain: Chain;

  constructor(providers: ProviderConfig[], chain: Chain = mainnet) {
    this.chain = chain;
    this.providers = providers.map((p) => ({
      url: p.url,
      client: createPublicClient({
        chain,
        transport: http(p.url),
      }),
    }));
    if (this.providers.length === 0) {
      console.error("[ERROR] No RPC_URLS provided. Exiting...");
      process.exit(1);
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
    this.monitorInterval.unref();
  }

  private async checkProviders() {
    let maxHeight = 0;

    // 1. Fetch current block height from all providers
    for (const p of this.providers) {
      try {
        const height = Number(await p.client.getBlockNumber());
        this.blockHeights.set(p.url, height);
        if (height > maxHeight) maxHeight = height;
      } catch (e) {
        // If we can't even connect or get block number, it's unhealthy
        if (debug)
          console.debug(`[DEBUG] [Reliability Layer] Provider ${stripSensitiveEndpoints(p.url)} is unavailable.`);
        this.unhealthyProviders.add(p.url);
      }
    }

    // 2. Mark providers as unhealthy if they lag by more than 3 blocks (Stale Data Check)
    const STALE_THRESHOLD = 3;
    for (const p of this.providers) {
      // If it already failed connection (in loop above), skip logic, it's already in unhealthy set
      if (!this.blockHeights.has(p.url)) {
        if (debug)
          console.debug(`[DEBUG] [Reliability Layer] Provider ${stripSensitiveEndpoints(p.url)} is unavailable.`);
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
          if (debug) console.log(`[DEBUG] [Reliability Layer] Provider ${stripSensitiveEndpoints(p.url)} recovered.`);
          this.unhealthyProviders.delete(p.url);
        }
      }
    }
  }

  public getClient(): PublicClient {
    const activeUrls = this.providers.filter((p) => !this.unhealthyProviders.has(p.url)).map((p) => p.url);
    const effectiveUrls = activeUrls.length > 0 ? activeUrls : [this.providers[0].url];
    const key = effectiveUrls.join(",");
    if (!this.cachedClient || key !== this.cachedClientKey) {
      this.cachedClient = createPublicClient({
        chain: this.chain,
        transport: fallback(
          effectiveUrls.map((u) => http(u)),
          { rank: true },
        ),
      });
      this.cachedClientKey = key;
    }
    return this.cachedClient;
  }
}

export class BlockchainClient {
  private manager: ReliableProviderManager;

  constructor(providers: ProviderConfig[], chain: Chain = mainnet) {
    this.manager = new ReliableProviderManager(providers, chain);
  }

  getClient(): PublicClient {
    return this.manager.getClient();
  }

  async getBlockNumber(): Promise<bigint> {
    return this.manager.getClient().getBlockNumber();
  }

  async fetchBlockHeader(blockNumber: bigint) {
    return this.manager.getClient().getBlock({ blockNumber });
  }

  /**
   * Fetches a block, all its transactions, and all its logs, transforming them into our schema format.
   */
  async fetchBlockData(blockNumber: bigint): Promise<BlockIngestData> {
    const client = this.getClient();

    try {
      const block = await client.getBlock({
        blockNumber: blockNumber,
        includeTransactions: true,
      });

      const validatedTxs: ValidatedTransaction[] = [];
      const validatedLogs: ValidatedLog[] = [];

      for (const tx of block.transactions) {
        if (typeof tx === "string") continue;

        validatedTxs.push({
          blockNumber: block.number,
          blockHash: block.hash!,
          transactionHash: tx.hash,
          transactionIndex: Number(tx.transactionIndex),
          from: tx.from,
          to: tx.to || undefined,
          amount: tx.value.toString(),
          isInternalCall: false,
        });
      }

      try {
        const receipts = await client.getBlockReceipts({
          blockNumber: blockNumber,
        });

        for (const receipt of receipts) {
          for (const log of receipt.logs) {
            validatedLogs.push({
              blockNumber: log.blockNumber ?? block.number,
              blockHash: (log.blockHash ?? block.hash)!,
              transactionHash: log.transactionHash ?? receipt.transactionHash,
              transactionIndex: Number(log.transactionIndex ?? receipt.transactionIndex),
              logIndex: Number(log.logIndex),
              address: log.address,
              data: log.data,
              topics: [...log.topics],
            });
          }
        }
      } catch {
        const logs = await client.getLogs({
          fromBlock: blockNumber,
          toBlock: blockNumber,
        });

        for (const log of logs) {
          validatedLogs.push({
            blockNumber: log.blockNumber ?? block.number,
            blockHash: (log.blockHash ?? block.hash)!,
            transactionHash: log.transactionHash!,
            transactionIndex: Number(log.transactionIndex),
            logIndex: Number(log.logIndex),
            address: log.address,
            data: log.data,
            topics: [...log.topics],
          });
        }
      }

      return {
        blockNumber: block.number,
        blockHash: block.hash!,
        parentHash: block.parentHash,
        transactions: validatedTxs,
        logs: validatedLogs,
      };
    } catch (error) {
      console.error(`Error fetching block ${blockNumber}:`, error);
      throw error;
    }
  }

  static fromEnv(chain: Chain = mainnet): BlockchainClient {
    const rpcUrls = (process.env.RPC_URLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return new BlockchainClient(
      rpcUrls.map((url) => ({ url })),
      chain,
    );
  }
}
