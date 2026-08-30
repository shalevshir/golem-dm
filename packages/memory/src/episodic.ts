// Episodic memory: pgvector embeddings of scene summaries (not raw turns).
// Same Postgres instance as world state — transactional consistency, one
// service. The store takes vectors; embedding happens at the composition
// root, so nothing here calls a model.
export * from "./episodic/port.js";
export * from "./episodic/in-memory.js";
