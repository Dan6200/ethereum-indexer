import { test, expect } from "bun:test";
import { reconcileFork } from "./daemon";
import type { BlockchainClient } from "@app/blockchain";
import type { IndexerDb } from "@app/db-core";

interface Header {
  hash: string;
  parentHash: string;
}

interface StoredBlock {
  number: bigint;
  hash: string;
}

const H0 = "0x" + "00".repeat(32);
const H1 = "0x" + "11".repeat(32);
const H1_ours = "0x" + "1a".repeat(32);
const H1_canon = "0x" + "1b".repeat(32);
const H2 = "0x" + "22".repeat(32);
const H2_ours = "0x" + "2a".repeat(32);
const H2_canon = "0x" + "2b".repeat(32);
const H3_ours = "0x" + "3a".repeat(32);
const H3_canon = "0x" + "3b".repeat(32);

function makeChain(headers: Map<bigint, Header>) {
  return {
    fetchBlockHeader: async (n: bigint) => headers.get(n),
  } as unknown as BlockchainClient;
}

function makeDb(stored: Map<bigint, StoredBlock>, calls: { n: bigint; h: string }[]) {
  return {
    getBlock: async (n: bigint) => stored.get(n) ?? null,
    rollbackState: async (n: bigint, h: string) => {
      calls.push({ n, h });
    },
  } as unknown as IndexerDb;
}

test("fast path: 1-block reorg rolls back a single block", async () => {
  const headers = new Map<bigint, Header>([
    [2n, { hash: H2, parentHash: H1 }],
    [3n, { hash: H3_canon, parentHash: H2 }],
  ]);
  const stored = new Map<bigint, StoredBlock>([
    [2n, { number: 2n, hash: H2 }],
    [3n, { number: 3n, hash: H3_ours }],
  ]);
  const calls: { n: bigint; h: string }[] = [];
  const chain = makeChain(headers);
  const db = makeDb(stored, calls);

  await reconcileFork(chain, db, 3n);

  expect(calls).toEqual([{ n: 2n, h: H2 }]);
});

test("walk-back: 2-block reorg rolls back to the common ancestor", async () => {
  const headers = new Map<bigint, Header>([
    [1n, { hash: H1, parentHash: H0 }],
    [2n, { hash: H2_canon, parentHash: H1 }],
    [3n, { hash: H3_canon, parentHash: H2_canon }],
  ]);
  const stored = new Map<bigint, StoredBlock>([
    [1n, { number: 1n, hash: H1 }],
    [2n, { number: 2n, hash: H2_ours }],
    [3n, { number: 3n, hash: H3_ours }],
  ]);
  const calls: { n: bigint; h: string }[] = [];
  const chain = makeChain(headers);
  const db = makeDb(stored, calls);

  await reconcileFork(chain, db, 3n);

  expect(calls).toEqual([{ n: 1n, h: H1 }]);
});

test("missing ancestry rejects", async () => {
  const headers = new Map<bigint, Header>([
    [1n, { hash: H1_canon, parentHash: H0 }],
    [2n, { hash: H2_canon, parentHash: H1_canon }],
  ]);
  const stored = new Map<bigint, StoredBlock>([[1n, { number: 1n, hash: H1_ours }]]);
  const calls: { n: bigint; h: string }[] = [];
  const chain = makeChain(headers);
  const db = makeDb(stored, calls);

  expect(reconcileFork(chain, db, 2n)).rejects.toThrow(/ancestry/);
});
