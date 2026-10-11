import "./load-env";
import { main } from "./daemon";
import { BlockchainClient } from "@app/blockchain";
import { IndexerDb } from "@app/db-core";

main(BlockchainClient.fromEnv(), IndexerDb.fromEnv()).catch(console.error);
