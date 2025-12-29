# Custom Ethereum Indexer

A high-performance, fault-tolerant Ethereum indexer built with Node.js, TypeScript, and PostgreSQL. This project is designed to handle chain reorganizations (re-orgs) automatically and ensure data integrity through strict runtime schema validation.

## Architecture

This project is a **monorepo** managed by `pnpm`, consisting of two primary applications and shared libraries:

### Applications

- **Indexer Management Utility (IMU)** (`packages/imu`): A CLI tool for high-risk maintenance tasks like manual rollbacks, historical backfilling, and database migrations. It runs independently of the live daemon to ensure safety.
- **Real-Time Indexer Daemon** (`packages/indexer-daemon`): The long-running service that listens to the blockchain head, detects re-orgs, and ingests data in real-time.

### Shared Libraries

- **@app/schemas** (`packages/schemas`): runtime data validation using [Zod](https://zod.dev). Defines the "source of truth" for data shapes (e.g., `TransactionSchema`).
- **@app/db-core** (`packages/db-core`): Shared database logic, connection pooling, and critical atomic operations (like `rollbackState`).

## Key Features

- **Re-org Defense**: Atomic database rollbacks to handle blockchain forks cleanly.
- **Data Integrity**: strict `Zod` validation prevents bad data from ever entering the database.
- **Performance**:
  - **Partitioning**: PostgreSQL range partitioning by `block_number` for scalable storage.
  - **Efficient Indexing**: Uses BRIN indexes for block ranges and B-Trees for high-cardinality lookups.
  - **Precision**: Uses `NUMERIC` types for all financial values (ETH/Tokens) to avoid floating-point errors.

## Prerequisites

- **Node.js**: v18+
- **pnpm**: v8+
- **PostgreSQL**: v14+ (Required for partitioning features)

## Setup & Installation

1.  **Clone the repository:**

    ```bash
    git clone <repo-url>
    cd custom-eth-indexer
    ```

2.  **Install dependencies:**

    ```bash
    pnpm install
    ```

3.  **Database Setup:**
    Ensure you have a PostgreSQL database running. You can apply the schema manually for now:
    ```bash
    psql -h localhost -U postgres -d indexer -f packages/db-core/src/schema.sql
    ```

## Configuration

Create a `.env` file in the root or specific package directories (though currently, the code defaults to standard local settings):

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=indexer
```

## Development

To build all packages:

```bash
pnpm run build
```

## License

[MIT](LICENSE)
