-- JEV V4.2 PHASE 4 — MANUAL ROLLBACK for migrations/0004_strategy_registry.sql.
-- Kept OUTSIDE migrations/ on purpose: wrangler would otherwise auto-apply it.
--
-- DESTRUCTIVE: drops ALL strategy-domain data. Do NOT run automatically.
-- Backup first:  wrangler d1 export paper_test --local --output=./p4_backup.sql
-- Then apply in order (children before parents):
DROP TABLE IF EXISTS daily_performance;
DROP TABLE IF EXISTS risk_rejections;
DROP TABLE IF EXISTS oos_results;
DROP TABLE IF EXISTS backtest_results;
DROP TABLE IF EXISTS research_runs;
DROP TABLE IF EXISTS strategy_versions;

-- Note: wrangler records 0004 as applied. To re-apply after this rollback,
-- remove that row manually from the local migrations bookkeeping table.
-- Production databases are out of scope for V4.2.
