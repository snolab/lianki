-- The token counts of each Learning Partner reply (docs/payments.md, "Cost
-- ledger", "Learning Partner tokens"), so /dev/costs can show tokens per day
-- and the prompt cache hit rate. Written once when the reply settles
-- (settleAi): prompt tokens, the part of them Workers AI served from its
-- prefix cache (prompt_tokens_details.cached_tokens), and completion tokens.
-- Counts only: no text. NULL on rows settled before this migration, and on
-- charges that are not Learning Partner replies.
ALTER TABLE credit_ai_charge ADD COLUMN tokensIn INTEGER;
ALTER TABLE credit_ai_charge ADD COLUMN cachedIn INTEGER;
ALTER TABLE credit_ai_charge ADD COLUMN tokensOut INTEGER;
