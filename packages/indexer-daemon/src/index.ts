import "./load-env";
import { main } from "./daemon";
import { BlockchainClient } from "@app/blockchain";
import { IndexerDb } from "@app/db-core";

async function start(): Promise<void> {
  const db = IndexerDb.fromEnv();
  const lock = await db.acquireSingletonLock(); // throws if another daemon holds it
  const shutdown = () => {
    void lock.release().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await main(BlockchainClient.fromEnv(), db);
}

start().catch((err) => {
  console.error(`[ERROR] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
