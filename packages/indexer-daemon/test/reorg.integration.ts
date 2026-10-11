/**
 * End-to-end reorg handling integration test.
 *
 * Standalone script (NOT a bun:test file). Run from the repo root:
 *
 *   bun packages/indexer-daemon/test/reorg.integration.ts
 *
 * It boots a real Anvil node with manual mining, creates a scratch Postgres
 * database, ingests a chain, forces a reorg with evm_snapshot/evm_revert, then
 * runs the daemon's detect -> reconcile -> re-ingest loop until the DB mirrors
 * the new canonical chain. Prints PASS/FAIL per assertion and exits non-zero if
 * anything fails.
 */

import { resolve } from "node:path";
import { ingest, reconcileFork } from "../src/daemon";
import { BlockchainClient } from "@app/blockchain";
import { IndexerDb } from "@app/db-core";

// --- Environment -----------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCHEMA_PATH = resolve(REPO_ROOT, "packages/db-core/src/schema.sql");
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? "/home/darealestninja/.foundry/bin";
const ANVIL_BIN = resolve(FOUNDRY_BIN, "anvil");
const RPC_URL = "http://localhost:8545";
const DB_NAME = "indexer_test";
const DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres" };

// `viem` and `pg` are dependencies of sibling workspace packages, not of
// indexer-daemon, so (with Bun's isolated install layout) they are not
// resolvable from this file. Resolve them relative to the packages that own
// them so the test stays a single self-contained file.
const { foundry } = (await import(Bun.resolveSync("viem/chains", resolve(REPO_ROOT, "packages/blockchain")))) as {
  foundry: any;
};
const { Pool } = (await import(Bun.resolveSync("pg", resolve(REPO_ROOT, "packages/db-core")))) as {
  Pool: any;
};

const CHILD_ENV = { ...process.env, PATH: `${FOUNDRY_BIN}:${process.env.PATH ?? ""}`, PGPASSWORD: DB.password };

// --- Tiny test harness ------------------------------------------------------

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`PASS: ${name}`);
  } else {
    failures++;
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sh(cmd: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { env: CHILD_ENV, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function castRpc(method: string, ...params: string[]): string {
  const r = sh(["cast", "rpc", method, ...params, "--rpc-url", RPC_URL]);
  if (r.code !== 0) throw new Error(`cast rpc ${method} failed: ${r.err.trim() || r.out.trim()}`);
  return r.out.trim().replace(/^"|"$/g, "");
}

async function waitForRpc(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      castRpc("eth_blockNumber");
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("Anvil did not become ready in time");
}

// --- Per-step sync helper (adapted to daemon.ts signatures) -----------------
//
// daemon.ts exports `ingest(db, block)` and `reconcileFork(chain, db, head)`.
// The only change from the reference pseudocode is that the empty-DB seed starts
// at block 1 (not the current chain head) so the ancestry rows 1..N are actually
// written, which is what makes the later fork walk-back possible.

async function step(chain: BlockchainClient, db: IndexerDb, seedFrom = 1n): Promise<void> {
  const chainHead = await chain.getBlockNumber();
  const dbHead = await db.getHeadBlock();

  if (dbHead === null) {
    const data = await chain.fetchBlockData(seedFrom);
    console.log(`  [ingest] seed block ${data.blockNumber} (${data.blockHash})`);
    await ingest(db, data);
    return;
  }

  const nextHeight = dbHead.number + 1n;
  if (nextHeight > chainHead) return; // synced

  const nextHeader = await chain.fetchBlockHeader(nextHeight);
  if (nextHeader.parentHash !== dbHead.hash) {
    console.log(`  [reconcile] fork detected at DB head ${dbHead.number} (${dbHead.hash}) -> reconcileFork`);
    await reconcileFork(chain, db, dbHead.number);
    return;
  }

  const data = await chain.fetchBlockData(nextHeight);
  console.log(`  [ingest] block ${data.blockNumber} (${data.blockHash})`);
  await ingest(db, data);
}

async function syncTo(chain: BlockchainClient, db: IndexerDb, target: bigint): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const head = await db.getHeadBlock();
    if (head?.number === target) return;
    await step(chain, db);
  }
  throw new Error(`syncTo(${target}) did not converge`);
}

// --- Main -------------------------------------------------------------------

let anvil: Bun.Subprocess | null = null;
let db: IndexerDb | null = null;

async function main(): Promise<void> {
  // 0. Preflight: the target port must be free so we own the node.
  try {
    castRpc("eth_blockNumber");
    throw new Error(`something already listening on ${RPC_URL}; refusing to reuse it`);
  } catch (e) {
    if ((e as Error).message.startsWith("something already")) throw e;
    // connection failure is expected here
  }

  // 1. Start Anvil with manual mining.
  console.log(`[anvil] starting on ${RPC_URL}`);
  anvil = Bun.spawn([ANVIL_BIN, "--host", "127.0.0.1", "--port", "8545", "--silent"], {
    env: CHILD_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForRpc();
  console.log(`[anvil] ready (version ${sh(["anvil", "--version"]).out.split("\n")[0].trim()})`);

  // 2. Scratch DB: drop/create + schema.
  console.log(`[db] recreating ${DB_NAME}`);
  let r = sh(["psql", "-h", DB.host, "-U", DB.user, "-c", `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  if (r.code !== 0) throw new Error(`drop database failed: ${r.err}`);
  r = sh(["psql", "-h", DB.host, "-U", DB.user, "-c", `CREATE DATABASE ${DB_NAME}`]);
  if (r.code !== 0) throw new Error(`create database failed: ${r.err}`);
  r = sh(["psql", "-h", DB.host, "-U", DB.user, "-d", DB_NAME, "-f", SCHEMA_PATH]);
  if (r.code !== 0) throw new Error(`apply schema failed: ${r.err}`);

  // 3. Construct clients.
  const chain = new BlockchainClient([{ url: RPC_URL }], foundry);
  db = new IndexerDb(
    new Pool({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: DB_NAME }),
  );

  // 4. Ingest phase: blocks 1..5, capture snapshot, mine 4..5.
  console.log("[phase] ingest");
  castRpc("anvil_mine", "3");
  const snapshotId = castRpc("evm_snapshot");
  castRpc("anvil_mine", "2");

  await syncTo(chain, db, 5n);
  const headPre = await db.getHeadBlock();
  const oldH4 = (await db.getBlock(4n))!.hash;
  const oldH5 = (await db.getBlock(5n))!.hash;
  console.log(`  [state] DB head = ${headPre!.number} (${headPre!.hash})`);
  check("pre-reorg DB head is block 5", headPre!.number === 5n);

  // 5. Reorg: revert to the snapshot (block 3) then mine 3 fresh blocks (4', 5', 6').
  console.log(`[phase] reorg (evm_revert ${snapshotId}, mine 3)`);
  const reverted = castRpc("evm_revert", snapshotId);
  if (reverted !== "true") throw new Error(`evm_revert returned ${reverted}`);
  castRpc("anvil_mine", "3");
  const canonicalHash4 = (await chain.fetchBlockHeader(4n)).hash;
  const canonicalHash5 = (await chain.fetchBlockHeader(5n)).hash;
  const canonicalHash6 = (await chain.fetchBlockHeader(6n)).hash;
  check("reorg produced a NEW block 4' hash", canonicalHash4 !== oldH4, `${oldH4} vs ${canonicalHash4}`);

  // 6. Detect + reconcile + re-ingest.
  console.log("[phase] reconcile + re-ingest");
  await syncTo(chain, db, 6n);

  // 7. Assertions.
  console.log("[phase] assertions");
  const headPost = await db.getHeadBlock();
  check(
    "db.getHeadBlock() === { number: 6n, hash: canonical block 6 }",
    headPost!.number === 6n && headPost!.hash === canonicalHash6,
    `got ${headPost!.number}/${headPost!.hash}, want 6/${canonicalHash6}`,
  );

  const stored4 = await db.getBlock(4n);
  check(
    "db.getBlock(4).hash === NEW block 4' hash",
    stored4 !== null && stored4.hash === canonicalHash4 && stored4.hash !== oldH4,
    `got ${stored4?.hash}, want ${canonicalHash4}`,
  );

  const stored5 = await db.getBlock(5n);
  check("db.getBlock(5).hash === NEW block 5' hash", stored5 !== null && stored5.hash === canonicalHash5);

  const leftovers = await db
    .getPool()
    .query(`SELECT block_hash FROM blocks WHERE block_hash = ANY($1::text[])`, [[oldH4, oldH5]]);
  check(
    "no blocks row remains for the old branch (old 4/5 hashes gone)",
    leftovers.rows.length === 0,
    leftovers.rows.map((row: any) => row.block_hash).join(","),
  );

  const branchRows = await db.getPool().query(`SELECT block_number FROM blocks ORDER BY block_number`);
  console.log(`  [state] stored ancestry: [${branchRows.rows.map((row: any) => row.block_number).join(", ")}]`);
}

try {
  await main();
} catch (error) {
  failures++;
  console.error("ERROR:", error);
} finally {
  if (db) {
    try {
      await db.getPool().end();
    } catch {
      /* ignore */
    }
  }
  if (anvil) {
    anvil.kill();
    await anvil.exited.catch(() => {});
  }
  sh(["psql", "-h", DB.host, "-U", DB.user, "-c", `DROP DATABASE IF EXISTS ${DB_NAME}`]);
}

console.log("");
if (failures === 0) console.log("SUMMARY: ALL ASSERTIONS PASSED");
else console.log(`SUMMARY: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
