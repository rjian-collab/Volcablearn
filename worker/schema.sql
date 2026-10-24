-- Volcablearn 共有詞庫資料表（Cloudflare D1）
-- 在 D1 資料庫的 Console 貼上整段執行一次即可。

-- 共有單字：每個字一筆（w 是小寫英文，不會重複）
CREATE TABLE IF NOT EXISTS words (
  w           TEXT PRIMARY KEY,
  data        TEXT NOT NULL,              -- 單字資料（JSON：詞性、中文、例句…）
  cefr        TEXT,
  status      TEXT NOT NULL DEFAULT 'approved',  -- approved / pending / hidden / deleted
  reports     INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER,
  updated_at  INTEGER NOT NULL,
  note        TEXT                        -- AI 審核或站長的備註
);
CREATE INDEX IF NOT EXISTS idx_words_updated ON words(updated_at);
CREATE INDEX IF NOT EXISTS idx_words_status ON words(status);

-- 回報：同一個人對同一個字只算一次
CREATE TABLE IF NOT EXISTS reports (
  w          TEXT NOT NULL,
  uid        TEXT NOT NULL,
  reason     TEXT,
  created_at INTEGER,
  PRIMARY KEY (w, uid)
);

-- AI 拒絕的投稿（給站長看）
CREATE TABLE IF NOT EXISTS rejected (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  w          TEXT NOT NULL,
  data       TEXT NOT NULL,
  reason     TEXT,
  uid        TEXT,
  created_at INTEGER
);

-- 每日使用次數限制
CREATE TABLE IF NOT EXISTS quota (
  k    TEXT PRIMARY KEY,
  day  TEXT NOT NULL,
  n    INTEGER NOT NULL
);
