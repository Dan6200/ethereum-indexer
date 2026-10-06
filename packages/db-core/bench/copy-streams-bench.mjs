#!/usr/bin/env node
// Correctness + throughput benchmark for pg-copy-streams, runnable identically
// under node and bun (plain ESM, no TS/build step).
//   node copy-streams-bench.mjs [--rows N] [--runs M] [--baseline] [--no-batch]
//   bun  copy-streams-bench.mjs [--rows N] [--runs M] [--baseline] [--no-batch]

import pg from "pg";
import copyStreams from "pg-copy-streams";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const { from: copyFrom } = copyStreams;
const { Client } = pg;

const TABLE = "bench_copy_streams";
const STAGING = "staging_bench";
const COLS = "(id, amount, note, tags)";

const COPY_CHUNK_BYTES = 1024 * 1024; // ~1MB per CopyData frame

const runtime = process.versions.bun ? "bun" : "node";
const runtimeVersion = process.versions.bun || process.versions.node;

// --- argv ------------------------------------------------------------------
function parseArgs(argv) {
  const args = { rows: 100000, runs: 3, baseline: false, batch: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rows") args.rows = parseInt(argv[++i], 10);
    else if (a === "--runs") args.runs = parseInt(argv[++i], 10);
    else if (a === "--baseline") args.baseline = true;
    else if (a === "--no-batch") args.batch = false;
  }
  if (!Number.isFinite(args.rows) || args.rows < 1) args.rows = 100000;
  if (!Number.isFinite(args.runs) || args.runs < 1) args.runs = 3;
  return args;
}

function makeClient() {
  return new Client({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "indexer",
  });
}

// --- data generation -------------------------------------------------------
// Deterministic synthetic row. note/tags cover the tricky COPY cases:
// SQL NULL is emitted as the literal `\N`, TEXT[] as `{a,b}`.
function genRow(i) {
  return {
    id: String(i + 1),
    amount: "1000000000000000000" + String(i),
    note: i % 5 === 0 ? null : `note-${i}`,
    tags: [`tag-${i}-a`, `tag-${i}-b`],
  };
}

function toCopyLine(row) {
  const note = row.note === null ? "\\N" : row.note;
  return `${row.id}\t${row.amount}\t${note}\t{${row.tags.join(",")}}\n`;
}

// Push pre-formatted lines into the COPY stream. `batched` accumulates ~1MB
// CopyData frames; the legacy per-row path pushes one line per frame.
function pushLines(input, lines, batched) {
  if (batched) {
    let buf = "";
    for (const line of lines) {
      buf += line;
      if (buf.length >= COPY_CHUNK_BYTES) {
        input.push(buf);
        buf = "";
      }
    }
    if (buf.length > 0) input.push(buf);
    input.push(null);
  } else {
    for (const line of lines) input.push(line);
    input.push(null);
  }
}

// --- shared COPY->staging->merge transaction --------------------------------
async function copyMergeTransaction(client, lines, batched = true) {
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE ${STAGING} (LIKE ${TABLE} INCLUDING DEFAULTS) ON COMMIT DROP`);
  const stream = client.query(copyFrom(`COPY ${STAGING} ${COLS} FROM STDIN`));
  const input = new Readable({ read() {} });
  pushLines(input, lines, batched);
  await pipeline(input, stream);
  await client.query(
    `INSERT INTO ${TABLE} ${COLS} SELECT id, amount, note, tags FROM ${STAGING} ON CONFLICT (id) DO NOTHING`,
  );
  await client.query("COMMIT");
  return stream.rowCount;
}

// --- correctness ------------------------------------------------------------
async function runCorrectness(client, batched) {
  console.log("\n[correctness]");
  let ok = true;
  const fail = (label, got, expected) => {
    ok = false;
    console.log(`  FAIL: ${label} (got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)})`);
  };
  const pass = (label) => console.log(`  PASS: ${label}`);

  const N = 100;
  const rows = [];
  for (let i = 0; i < N; i++) rows.push(genRow(i));
  // Explicit known cases for the spot-checks:
  rows[3] = { id: "4", amount: "123456789012345678", note: null, tags: ["only-one"] };
  rows[7] = { id: "8", amount: "876543210987654321", note: "hello world", tags: ["alpha", "beta", "gamma"] };

  const lines = rows.map(toCopyLine);

  await copyMergeTransaction(client, lines, batched);
  const count1 = (await client.query(`SELECT COUNT(*)::int AS c FROM ${TABLE}`)).rows[0].c;
  if (count1 === N) pass(`first COPY+merge COUNT == ${N}`);
  else fail(`first COPY+merge COUNT == ${N}`, count1, N);

  const nullRow = (await client.query(`SELECT note FROM ${TABLE} WHERE id = '4'`)).rows[0];
  if (nullRow.note === null) pass("null note round-trips as SQL NULL");
  else fail("null note round-trips as SQL NULL", nullRow.note, null);

  const arrRow = (await client.query(`SELECT tags FROM ${TABLE} WHERE id = '8'`)).rows[0];
  const expectedTags = ["alpha", "beta", "gamma"];
  const arrMatch =
    Array.isArray(arrRow.tags) &&
    arrRow.tags.length === expectedTags.length &&
    arrRow.tags.every((v, i) => v === expectedTags[i]);
  if (arrMatch) pass("TEXT[] array round-trips");
  else fail("TEXT[] array round-trips", arrRow.tags, expectedTags);

  const noteRow = (await client.query(`SELECT note FROM ${TABLE} WHERE id = '8'`)).rows[0];
  if (noteRow.note === "hello world") pass("non-null note round-trips");
  else fail("non-null note round-trips", noteRow.note, "hello world");

  // Idempotency: same batch again must be a no-op under ON CONFLICT DO NOTHING.
  await copyMergeTransaction(client, lines, batched);
  const count2 = (await client.query(`SELECT COUNT(*)::int AS c FROM ${TABLE}`)).rows[0].c;
  if (count2 === N) pass(`second COPY+merge COUNT unchanged (== ${N})`);
  else fail(`second COPY+merge COUNT unchanged (== ${N})`, count2, N);

  return ok;
}

// --- throughput -------------------------------------------------------------
async function runThroughput(client, rows, runs, batched) {
  console.log(`\n[benchmark] rows=${rows.length} runs=${runs} batch=${batched}`);
  const lines = rows.map(toCopyLine);
  const times = [];
  for (let r = 1; r <= runs; r++) {
    await client.query(`TRUNCATE TABLE ${TABLE}`);
    const t0 = performance.now();
    await copyMergeTransaction(client, lines, batched);
    const ms = performance.now() - t0;
    times.push(ms);
    console.log(`  run ${r}/${runs}: ${ms.toFixed(1)} ms  ${((rows.length * 1000) / ms).toFixed(0)} rows/s`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const best = Math.max(...times.map((ms) => (rows.length * 1000) / ms));
  console.log(`  median rows/sec: ${((rows.length * 1000) / median).toFixed(0)}`);
  console.log(`  best rows/sec:   ${best.toFixed(0)}`);
  return { times, median, best };
}

// --- naive per-row INSERT baseline ------------------------------------------
async function runBaseline(client, rows, runs) {
  console.log(`\n[baseline] naive per-row INSERT rows=${rows.length} runs=${runs}`);
  const times = [];
  for (let r = 1; r <= runs; r++) {
    await client.query(`TRUNCATE TABLE ${TABLE}`);
    const t0 = performance.now();
    await client.query("BEGIN");
    for (const row of rows) {
      await client.query(`INSERT INTO ${TABLE} ${COLS} VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [
        row.id,
        row.amount,
        row.note,
        row.tags,
      ]);
    }
    await client.query("COMMIT");
    const ms = performance.now() - t0;
    times.push(ms);
    console.log(`  run ${r}/${runs}: ${ms.toFixed(1)} ms  ${((rows.length * 1000) / ms).toFixed(0)} rows/s`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  console.log(`  median rows/sec: ${((rows.length * 1000) / median).toFixed(0)}`);
}

// --- main -------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  console.log(`runtime: ${runtime} ${runtimeVersion}`);
  console.log(
    `pg-copy-streams ${copyStreams && copyStreams.from ? "loaded" : "MISSING"} | pg ${pg && pg.Client ? "loaded" : "MISSING"}`,
  );
  console.log(`table: ${TABLE} | rows=${args.rows} runs=${args.runs} baseline=${args.baseline} batch=${args.batch}`);

  const client = makeClient();
  await client.connect();

  try {
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.query(`
      CREATE TABLE ${TABLE} (
        id BIGINT PRIMARY KEY,
        amount NUMERIC NOT NULL,
        note TEXT,
        tags TEXT[] NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const correctnessOk = await runCorrectness(client, args.batch);

    const rows = [];
    for (let i = 0; i < args.rows; i++) rows.push(genRow(i));
    const bench = await runThroughput(client, rows, args.runs, args.batch);

    if (args.baseline) await runBaseline(client, rows, Math.max(1, Math.min(args.runs, 1)));

    if (!correctnessOk) {
      console.error("\nCORRECTNESS FAILED");
      process.exitCode = 1;
    } else {
      console.log("\ncorrectness: PASS");
    }
    console.log(`median rows/sec (COPY): ${((args.rows * 1000) / bench.median).toFixed(0)}`);
  } finally {
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
