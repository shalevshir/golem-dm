import { createInMemoryEventStore } from "./in-memory.js";
import { describeEventStoreContract } from "./contract.js";

// One store instance across every case, exactly as `postgres.test.ts` does:
// the suite mints a unique campaign id per case, so isolation comes from the
// key rather than from a fresh store, and running the two implementations
// under different lifecycles would mean the "same" suite is not the same
// experiment twice. A store per case would never see campaigns accumulate,
// which the Postgres side always does.
const store = createInMemoryEventStore();

describeEventStoreContract("in-memory EventStore", () => store);
