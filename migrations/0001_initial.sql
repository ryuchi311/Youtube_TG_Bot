CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config TEXT NOT NULL,
  lock_until INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO app_state (id, config, lock_until)
VALUES (
  1,
  '{"channels":[],"savedDestinations":[],"savedChannels":[],"pollIntervalMinutes":2,"messageTemplate":"<b>🔥 NEW UPLOAD WATCH NOW 🔥</b>\n━━━━━━━━━━━━━━━━\n🎬 {title}\n📺 {channel}\n📅 {published}\n<a href=\"{url}\">▶ Watch on YouTube</a>","lastScheduledCheckAt":null}',
  0
);
