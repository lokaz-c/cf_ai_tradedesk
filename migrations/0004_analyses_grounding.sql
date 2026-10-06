-- The post-check report for each saved answer, as JSON: the data the Worker
-- fetched for it (ticker, source, status), the numbers in the answer that
-- match provided values ("citations"), and the price-like numbers that match
-- nothing ("unverified"). NULL for answers saved before this migration.
-- Count unverified numbers with, for example:
--   SELECT sum(json_array_length(grounding, '$.unverified')) FROM analyses;
ALTER TABLE analyses ADD COLUMN grounding TEXT;
