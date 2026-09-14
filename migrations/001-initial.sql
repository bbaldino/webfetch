CREATE TABLE IF NOT EXISTS domain_stats (
  domain TEXT NOT NULL,
  method TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  failure INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (domain, method)
);

CREATE TABLE IF NOT EXISTS domain_config (
  domain TEXT PRIMARY KEY,
  method TEXT NOT NULL DEFAULT 'auto',
  share_cookies INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
