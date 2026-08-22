import { createInMemoryEventStore } from "./in-memory.js";
import { describeEventStoreContract } from "./contract.js";

describeEventStoreContract("in-memory EventStore", createInMemoryEventStore);
