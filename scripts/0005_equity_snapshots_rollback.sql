-- MANUAL ROLLBACK ONLY for migrations/0005_equity_snapshots.sql.
--
-- This file lives in scripts/ ON PURPOSE. If it were placed in migrations/,
-- `wrangler d1 migrations apply` would execute it automatically and DROP the
-- equity snapshot / provenance tables on the next deploy.
--
-- Before running:
--   node <wrangler>/bin/wrangler.js d1 export paper_test --local \
--     --output=backup-before-0005-rollback.sql
-- Verify the backup exists and is non-empty, then apply manually:
--   node <wrangler>/bin/wrangler.js d1 execute paper_test --local --file=this_file
--
-- Rollback scope: only the 4 tables + 3 indexes created by 0005.
-- 0001-0004 tables (including paper_accounts.state_json and the trading
-- replay chain) are NEVER touched by this script.

DROP TABLE IF EXISTS verification_receipts;
DROP TABLE IF EXISTS verification_nonces;
DROP TABLE IF EXISTS strategy_events;
DROP INDEX IF EXISTS idx_equity_snapshots_quality;
DROP INDEX IF EXISTS idx_equity_snapshots_account;
DROP TABLE IF EXISTS paper_equity_snapshots;
