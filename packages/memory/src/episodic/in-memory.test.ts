import { runEpisodicStoreContract } from "./contract.js";
import { createInMemoryEpisodicStore } from "./in-memory.js";

runEpisodicStoreContract("in-memory", () => createInMemoryEpisodicStore());
