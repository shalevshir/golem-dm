// Encounter-level state transitions: building a world and applying a validated
// turn to it. Everything here is pure — the caller injects the RNG and the
// stat blocks.
export * from "./build.js";
export * from "./resolve.js";
