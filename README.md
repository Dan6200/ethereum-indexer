# Custom Ethereum Indexer

A high-performance, fault-tolerant Ethereum indexer built with Node.js, TypeScript, and PostgreSQL. This project is designed to handle chain reorganizations (re-orgs) automatically and ensure data integrity through strict runtime schema validation.

## Architecture

This project is a **monorepo** managed by [bun](https://bun.sh) (the runtime and package manager), consisting of two primary applications and shared libraries:

### Applications

- **Indexer Management Utility (IMU)** (`packages/imu`): A CLI tool for high-risk maintenance tasks like manual rollbacks, historical backfilling, and database migrations. It runs independently of the live daemon to ensure safety.
- **Real-Time Indexer Daemon** (`packages/indexer-daemon`): The long-running service that listens to the blockchain head, detects re-orgs, and ingests data in real-time.

### Shared Libraries

- **@app/schemas** (`packages/schemas`): runtime data validation using [Zod](https://zod.dev). Defines the "source of truth" for data shapes (e.g., `TransactionSchema`).
- **@app/db-core** (`packages/db-core`): Shared database logic, connection pooling, and critical atomic operations (like `rollbackState`).
- **@app/blockchain** (`packages/blockchain`): Ethereum RPC client built on [viem](https://viem.sh), with provider failover and a health monitor across multiple RPC endpoints.

## Key Features

- **Re-org Defense**: Atomic database rollbacks to handle blockchain forks cleanly.
- **Data Integrity**: strict `Zod` validation prevents bad data from ever entering the database.
- **Performance**:
  - **Partitioning**: PostgreSQL range partitioning by `block_number` for scalable storage.
  - **Efficient Indexing**: Uses BRIN indexes for block ranges and B-Trees for high-cardinality lookups.
  - **Precision**: Uses `NUMERIC` types for all financial values (ETH/Tokens) to avoid floating-point errors.

## Prerequisites

- **bun**: v1.x (bundles its own JavaScript runtime; Node.js is not required separately)
- **Node.js**: v18+ (optional, only if you need to run scripts under `node` directly)
- **PostgreSQL**: v14+ (Required for partitioning features)

## Setup & Installation

1.  **Clone the repository:**

    ```bash
    git clone <repo-url>
    cd custom-eth-indexer
    ```

2.  **Install dependencies:**

    ```bash
    bun install
    ```

3.  **Database Setup:**
    Ensure you have a PostgreSQL database running. You can apply the schema manually for now:
    ```bash
    psql -h localhost -U postgres -d indexer -f packages/db-core/src/schema.sql
    ```

## Configuration

Create a `.env` file in the repo root (see `.env.example` for the full list of variables):

```env
# Ethereum RPC endpoints (comma-separated). Leave empty to fall back to Cloudflare.
RPC_URLS=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY

DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=indexer
```

bun automatically loads `.env` from the repo root, so run all commands below from the root. If you run from elsewhere, pass `--env-file .env` explicitly.

## Running / Development

All commands are run from the repo root so `.env` is picked up automatically.

Start the daemon:

```bash
bun run packages/indexer-daemon/src/index.ts
```

IMU backfill:

```bash
bun run packages/imu/src/index.ts backfill -s <startBlock> -e <endBlock>
```

IMU rollback:

```bash
bun run packages/imu/src/index.ts rollback <blockNumber>
```

IMU help:

```bash
bun run packages/imu/src/index.ts --help
```

Benchmark (pg-copy-streams, compare node vs bun):

```bash
bun packages/db-core/bench/copy-streams-bench.mjs --rows 100000 --runs 3
node packages/db-core/bench/copy-streams-bench.mjs --rows 100000 --runs 3
```

Available benchmark flags: `--no-batch` (disable COPY batching) and `--baseline` (naive per-row INSERT comparison).

To build all packages:

```bash
bun run build:all
# or
bun run --filter '*' build
```

## License

[MIT](LICENSE)
