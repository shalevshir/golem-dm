// Token accounting, in its own module so both `port.ts` (successful calls) and
// `errors.ts` (billed attempts that produced nothing usable) can name it
// without importing each other.
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
