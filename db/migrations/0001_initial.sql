CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  poster_id TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  visibility TEXT NOT NULL,
  reward INTEGER NOT NULL,
  requested_modes TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  safety_flags TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  contributor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  externally_generated INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  community_score INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL,
  rater_id TEXT NOT NULL,
  usefulness INTEGER NOT NULL,
  novelty INTEGER NOT NULL,
  correctness INTEGER NOT NULL,
  safety INTEGER NOT NULL,
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_votes (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  challenge_id TEXT,
  contribution_id TEXT,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS synthesis_briefs (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  job_id TEXT NOT NULL,
  brief_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  challenge_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  latency_ms INTEGER,
  cost_cents INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_events (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
