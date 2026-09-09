// Token accounting, in its own module so both `port.ts` (successful calls) and
// `errors.ts` (billed attempts that produced nothing usable) can name it
// without importing each other.
export interface TokenUsage {
  /**
   * Prompt tokens billed at the full input rate.
   *
   * On Anthropic this is `input_tokens`, which EXCLUDES both cache reads and
   * cache writes — so on a cached call it is the uncached remainder only, and
   * reading it as the whole prompt understates a run badly. The two fields
   * below carry the rest.
   */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens served from a cache hit, billed at a discount (Anthropic:
   * one tenth of the input rate). ADDITIVE to `promptTokens`, never included
   * in it — see that field.
   *
   * Absent when the provider reported no cache accounting at all, which is
   * not the same as zero: zero means "nothing was cached", absent means "this
   * provider did not say". Only populated for providers whose cache tokens
   * are excluded from the prompt count; a provider that already folds them in
   * must leave this absent rather than cause a double count.
   */
  cachedPromptTokens?: number;
  /**
   * Prompt tokens spent WRITING a cache entry, billed at a premium
   * (Anthropic: one and a quarter times the input rate). Additive, and absent
   * on the same terms as `cachedPromptTokens`.
   *
   * Separate from the read count because they bill in opposite directions,
   * and because a run that pays to write the prefix on every call is a
   * cache that is not working — indistinguishable from a working one if the
   * two are summed.
   */
  cacheWritePromptTokens?: number;
}
