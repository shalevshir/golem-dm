// The scene-summarizer contract. Its output is internal English game state
// for episodic retrieval to index — not narration, and never shown to a
// player. That is why it returns a plain string rather than a token stream:
// nothing renders a summary as it arrives.
export interface SceneSummaryInput {
  kind: "encounter" | "quest_node";
  /** The node card or encounter description. English. */
  contextEnglish: string;
  /**
   * What the engine knows happened — outcome, survivors, effects applied.
   * English, and the sole material the deterministic fallback uses.
   */
  factsEnglish: readonly string[];
  /**
   * The turn's narrations, Hebrew, oldest first. The interpretive half: the
   * facts say a node completed, these say how it felt and what was said.
   * Read as INPUT only — the summary itself is English (invariant 2).
   */
  recentNarrations: readonly string[];
}

export interface SceneSummaryPort {
  /**
   * `null` means "no usable summary" — a provider failure, an empty
   * completion, or a spent deadline. The caller substitutes the
   * deterministic summary rather than skipping the memory, so a null here is
   * a quality loss and never a missing row.
   */
  summarize(input: SceneSummaryInput): Promise<string | null>;
}
