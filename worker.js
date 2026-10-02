const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOCK_LEASE_MS = 5 * 60 * 1000;
const POLL_INTERVAL_OPTIONS = [1, 2, 5, 10, 15, 30, 60];
const DEFAULT_MESSAGE_TEMPLATE = "<b>🔥 NEW UPLOAD WATCH NOW 🔥</b>\n━━━━━━━━━━━━━━━━\n🎬 {title}\n📺 {channel}\n📅 {published}\n<a href=\"{url}\">▶ Watch on YouTube</a>";

class RequestError extends Error {}

function defaultConfig() {
  return {
    channels: [],
    savedDestinations: [],
    savedChannels: [],
    pollIntervalMinutes: 2,
    messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
    lastScheduledCheckAt: null,
  };
}

async function loadConfig(db) {
  const row = await db.prepare("SELECT config FROM app_state WHERE id = 1").first();
  if (!row) return defaultConfig();
  const config = JSON.parse(row.config);
  config.channels = Array.isArray(config.channels) ? config.channels : [];
  config.savedDestinations = Array.isArray(config.savedDestinations) ? config.savedDestinations : [];
  config.pollIntervalMinutes = POLL_INTERVAL_OPTIONS.includes(config.pollIntervalMinutes)
    ? config.pollIntervalMinutes
    : 2;
  config.messageTemplate = typeof config.messageTemplate === "string" && config.messageTemplate.trim()
    ? config.messageTemplate
    : DEFAULT_MESSAGE_TEMPLATE;
  if (!Array.isArray(config.savedChannels)) {
    config.savedChannels = config.channels.map((channel) => ({
      id: crypto.randomUUID(),
      name: channel.channelTitle || channel.id,
      channelId: channel.id,
    }));
  }
  for (const destination of config.savedDestinations) {
    if (destination.lastTestAt) continue;
    const routeTest = latestRouteTestForDestination(config, destination);
    if (!routeTest) continue;
    destination.lastTestAt = routeTest.lastTestAt;
    destination.lastTestError = routeTest.lastTestError || null;
  }
  return config;
}

async function saveConfig(db, config) {
  await db.prepare(
    "INSERT INTO app_state (id, config, lock_until) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET config = excluded.config",
  ).bind(JSON.stringify(config)).run();
}

function json(status, body, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

async function readJson(request) {
  const body = await request.text();
  if (body.length > 100_000) throw new RequestError("Request body is too large.");
  let value;
  try {
    value = JSON.parse(body || "{}");
  } catch {
    throw new RequestError("Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("Request body must be a JSON object.");
  }
  return value;
}

function checkOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  return cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || "";
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionSignature(token, expiresAt, password) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const payload = new TextEncoder().encode(`tubesignal-session:${token}:${expiresAt}`);
  return { key, payload };
}

async function sessionTokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createSession(db, password) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64UrlEncode(tokenBytes);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const { key, payload } = await sessionSignature(token, expiresAt, password);
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  const tokenHash = await sessionTokenHash(token);
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Math.floor(Date.now() / 1000)).run();
  await db.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)").bind(tokenHash, expiresAt).run();
  return `${token}.${expiresAt}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function isAuthenticated(request, db, password) {
  if (!password) return false;
  const token = cookieValue(request, "session");
  const [sessionToken, expiresText, signatureText, extra] = token.split(".");
  const expiresAt = Number(expiresText);
  const now = Math.floor(Date.now() / 1000);
  if (
    extra ||
    !/^[A-Za-z0-9_-]{43}$/.test(sessionToken) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + SESSION_TTL_SECONDS
  ) return false;
  let verified = false;
  try {
    const { key, payload } = await sessionSignature(sessionToken, expiresAt, password);
    verified = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signatureText), payload);
  } catch {
    return false;
  }
  if (!verified) return false;
  const tokenHash = await sessionTokenHash(sessionToken);
  const session = await db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash).first();
  return Number(session?.expires_at) === expiresAt && expiresAt > now;
}

async function revokeSession(request, db) {
  const [sessionToken] = cookieValue(request, "session").split(".");
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return;
  const tokenHash = await sessionTokenHash(sessionToken);
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

function sessionCookie(token, request) {
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

function validateDestination(destination) {
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    throw new RequestError("Each Telegram destination must be an object.");
  }
  const chatId = typeof destination.chatId === "string" ? destination.chatId.trim() : "";
  const topicId = typeof destination.topicId === "string" ? destination.topicId.trim() : "";
  if (!/^(?:-?\d+|@[A-Za-z0-9_]{5,32})$/.test(chatId)) {
    throw new RequestError("Telegram chat IDs must be numeric (including -100 group IDs) or a @channel username.");
  }
  if (topicId && !/^[1-9]\d*$/.test(topicId)) {
    throw new RequestError("Topic IDs must be positive numbers, or left blank.");
  }
  return { chatId, topicId };
}

function latestRouteTestForDestination(config, destination) {
  return config.channels
    .flatMap((channel) => channel.destinations || [])
    .filter((item) =>
      item.chatId === destination.chatId &&
      item.topicId === destination.topicId &&
      typeof item.lastTestAt === "string" &&
      Number.isFinite(Date.parse(item.lastTestAt)))
    .sort((left, right) => Date.parse(right.lastTestAt) - Date.parse(left.lastTestAt))[0] || null;
}

function validateSavedDestinations(input, config) {
  if (!Array.isArray(input) || input.length > 100) throw new RequestError("Save up to 100 Telegram destinations.");
  const ids = new Set();
  const keys = new Set();
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RequestError("Each saved destination must be an object.");
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new RequestError("Each saved destination needs a valid ID.");
    if (ids.has(id)) throw new RequestError("Saved destination IDs must be unique.");
    ids.add(id);
    if (!name || name.length > 80) throw new RequestError("Each saved destination needs a name of 1 to 80 characters.");
    const destination = validateDestination(item);
    const key = `${destination.chatId}:${destination.topicId}`;
    if (keys.has(key)) throw new RequestError("A group/topic can only be saved once. Remove the duplicate saved destination.");
    keys.add(key);
    const existingById = config.savedDestinations.find((saved) => saved.id === id);
    const existingForDestination = config.savedDestinations.find((saved) =>
      saved.chatId === destination.chatId && saved.topicId === destination.topicId);
    const prior = existingById
      ? existingById.chatId === destination.chatId && existingById.topicId === destination.topicId
        ? existingById
        : null
      : existingForDestination;
    const testState = prior?.lastTestAt ? prior : latestRouteTestForDestination(config, destination);
    return {
      id,
      name,
      ...destination,
      lastTestAt: testState?.lastTestAt || (existingById ? null : typeof item.lastTestAt === "string" ? item.lastTestAt : null),
      lastTestError: testState?.lastTestError || (existingById ? null : typeof item.lastTestError === "string" ? item.lastTestError : null),
    };
  });
}

function validateSavedChannels(input) {
  if (!Array.isArray(input) || input.length > 100) throw new RequestError("Save up to 100 YouTube channels.");
  const ids = new Set();
  const channelIds = new Set();
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RequestError("Each saved channel must be an object.");
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const channelId = typeof item.channelId === "string" ? item.channelId.trim() : "";
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new RequestError("Each saved channel needs a valid ID.");
    if (ids.has(id)) throw new RequestError("Saved channel IDs must be unique.");
    ids.add(id);
    if (!name || name.length > 80) throw new RequestError("Each saved channel needs a name of 1 to 80 characters.");
    if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
      throw new RequestError("Each saved YouTube channel ID must start with UC and contain 24 characters.");
    }
    if (channelIds.has(channelId)) throw new RequestError("YouTube channel IDs must be unique in the saved list.");
    channelIds.add(channelId);
    return { id, name, channelId };
  });
}

function validateChannels(input, config) {
  if (!Array.isArray(input) || input.length > 100) throw new RequestError("Add up to 100 YouTube channels.");
  const ids = new Set();
  return input.map((channel) => {
    if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
      throw new RequestError("Each YouTube route must be an object.");
    }
    const id = typeof channel.id === "string" ? channel.id.trim() : "";
    if (!/^UC[a-zA-Z0-9_-]{22}$/.test(id)) {
      throw new RequestError("Each YouTube channel ID must start with UC and contain 24 characters.");
    }
    if (ids.has(id)) {
      throw new RequestError("Each YouTube channel can have only one notification route. Add destinations to its existing route.");
    }
    ids.add(id);
    if (!Array.isArray(channel.destinations) || channel.destinations.length === 0 || channel.destinations.length > 30) {
      throw new RequestError("Each channel needs between 1 and 30 Telegram destinations.");
    }
    const keys = new Set();
    const destinations = channel.destinations.map((item) => {
      const destination = validateDestination(item);
      const key = `${destination.chatId}:${destination.topicId}`;
      if (keys.has(key)) throw new RequestError("A Telegram destination is duplicated for this channel.");
      keys.add(key);
      return destination;
    });
    const current = config.channels.find((existing) => existing.id === id);
    return {
      id,
      destinations: destinations.map((destination) => {
        const previous = current?.destinations.find((item) =>
          item.chatId === destination.chatId && item.topicId === destination.topicId);
        return {
          ...destination,
          lastVideoId: previous?.lastVideoId || null,
          lastNotifiedAt: previous?.lastNotifiedAt || null,
          lastNotifiedVideoTitle: previous?.lastNotifiedVideoTitle || null,
          lastTestAt: previous?.lastTestAt || null,
          lastTestError: previous?.lastTestError || null,
        };
      }),
      lastVideoId: current?.lastVideoId || null,
      lastCheckedAt: current?.lastCheckedAt || null,
      lastError: current?.lastError || null,
      channelTitle: current?.channelTitle || null,
      latestVideoId: current?.latestVideoId || null,
      latestVideoTitle: current?.latestVideoTitle || null,
      latestVideoPublished: current?.latestVideoPublished || null,
    };
  });
}

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (code[0] !== "#") return named[code.toLowerCase()] || entity;
    const number = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(number) && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function fetchFeed(channelId) {
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
    headers: { "User-Agent": "YouTubeTelegramNotifier/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) throw new RequestError("YouTube could not find a public channel for that ID. Check the ID and try again.");
  if (!response.ok) throw new Error(`YouTube returned HTTP ${response.status}.`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
    const id = entry.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/)?.[1];
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1];
    return id && title ? { id: decodeXml(id), title: decodeXml(title), published } : null;
  }).filter(Boolean);
  const author = xml.match(/<author>\s*<name>([\s\S]*?)<\/name>/)?.[1];
  const channelTitle = author ? decodeXml(author).trim() : null;
  if (!channelTitle) {
    throw new RequestError("YouTube returned no public channel details for that ID. Verify the channel ID and that the channel is public.");
  }
  return { entries, channelTitle };
}

function formatVideoMessage(template, channel, video) {
  const published = video.published && !Number.isNaN(new Date(video.published).getTime())
    ? new Date(video.published).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })
    : "Publication date unavailable";
  const values = {
    title: video.title,
    channel: channel.channelTitle || "YouTube channel",
    published,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
    videoId: video.id,
  };
  return template.replace(/\{(title|channel|published|url|videoId)\}/g, (_, key) => escapeHtml(values[key]));
}

async function telegramRequest(token, method, payload) {
  if (!token) throw new RequestError("Set TELEGRAM_BOT_TOKEN in the environment before looking up Telegram chats.");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram returned HTTP ${response.status}.`);
  return result.result;
}

async function telegramSend(token, destination, text) {
  const payload = { chat_id: destination.chatId, text, parse_mode: "HTML", disable_web_page_preview: false };
  if (destination.topicId) payload.message_thread_id = Number(destination.topicId);
  await telegramRequest(token, "sendMessage", payload);
}

async function telegramSendPhoto(token, destination, photo, caption) {
  const payload = { chat_id: destination.chatId, photo, caption, parse_mode: "HTML" };
  if (destination.topicId) payload.message_thread_id = Number(destination.topicId);
  await telegramRequest(token, "sendPhoto", payload);
}

async function checkChannel(channel, config, token) {
  try {
    const { entries, channelTitle } = await fetchFeed(channel.id);
    channel.channelTitle = channelTitle || channel.channelTitle;
    if (entries.length > 0) {
      channel.latestVideoId = entries[0].id;
      channel.latestVideoTitle = entries[0].title;
      channel.latestVideoPublished = entries[0].published || null;
    }
    if (entries.length === 0) {
      channel.lastCheckedAt = new Date().toISOString();
      channel.lastError = null;
      return;
    }
    const newest = entries[0];
    for (const destination of channel.destinations) {
      if (!destination.lastVideoId) {
        const caption = formatVideoMessage(config.messageTemplate, channel, newest);
        const thumbnail = `https://i.ytimg.com/vi/${encodeURIComponent(newest.id)}/hqdefault.jpg`;
        await telegramSendPhoto(token, destination, thumbnail, caption);
        destination.lastVideoId = newest.id;
        destination.lastNotifiedAt = new Date().toISOString();
        destination.lastNotifiedVideoTitle = newest.title;
        continue;
      }
      const unseen = [];
      for (const entry of entries) {
        if (entry.id === destination.lastVideoId) break;
        unseen.push(entry);
      }
      for (const entry of unseen.reverse()) {
        const caption = formatVideoMessage(config.messageTemplate, channel, entry);
        const thumbnail = `https://i.ytimg.com/vi/${encodeURIComponent(entry.id)}/hqdefault.jpg`;
        await telegramSendPhoto(token, destination, thumbnail, caption);
        destination.lastVideoId = entry.id;
        destination.lastNotifiedAt = new Date().toISOString();
        destination.lastNotifiedVideoTitle = entry.title;
      }
    }
    channel.lastVideoId = newest.id;
    channel.lastCheckedAt = new Date().toISOString();
    channel.lastError = null;
  } catch (error) {
    channel.lastCheckedAt = new Date().toISOString();
    channel.lastError = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "YouTube channel check failed", channelId: channel.id, error: channel.lastError }));
  }
}

async function acquireLock(db) {
  const now = Date.now();
  const result = await db.prepare("UPDATE app_state SET lock_until = ? WHERE id = 1 AND lock_until < ?")
    .bind(now + LOCK_LEASE_MS, now).run();
  return result.meta.changes === 1;
}

async function withConfigLock(db, callback) {
  const now = Date.now();
  let acquired = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await acquireLock(db)) {
      acquired = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  if (!acquired) throw new RequestError("Another update is running. Please try again in a few seconds.");
  try {
    const config = await loadConfig(db);
    const result = await callback(config);
    await saveConfig(db, config);
    return result;
  } finally {
    await db.prepare("UPDATE app_state SET lock_until = 0 WHERE id = 1").run();
  }
}

async function checkAllChannels(db, token) {
  return withConfigLock(db, async (config) => {
    for (const channel of config.channels) await checkChannel(channel, config, token);
    return config.channels;
  });
}

async function runScheduledCheck(env) {
  const now = Date.now();
  const acquired = await acquireLock(env.DB);
  if (!acquired) return;
  try {
    const config = await loadConfig(env.DB);
    const intervalMs = config.pollIntervalMinutes * 60_000;
    const lastCheck = Date.parse(config.lastScheduledCheckAt || "");
    if (Number.isFinite(lastCheck) && now - lastCheck < intervalMs) return;
    config.lastScheduledCheckAt = new Date(now).toISOString();
    await saveConfig(env.DB, config);
    for (const channel of config.channels) await checkChannel(channel, config, env.TELEGRAM_BOT_TOKEN);
    await saveConfig(env.DB, config);
  } finally {
    await env.DB.prepare("UPDATE app_state SET lock_until = 0 WHERE id = 1").run();
  }
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const asset = (async () => {
    if (!env.ASSETS) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  });
  try {
    if (!url.pathname.startsWith("/api/")) {
      const response = await asset();
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
      headers.set("Referrer-Policy", "same-origin");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!checkOrigin(request)) return json(403, { error: "Request origin is not allowed." });
      if (!env.ADMIN_PASSWORD) return json(503, { error: "Set ADMIN_PASSWORD as a Worker secret before signing in." });
      const body = await readJson(request);
      const provided = new TextEncoder().encode(typeof body.password === "string" ? body.password : "");
      const expected = new TextEncoder().encode(env.ADMIN_PASSWORD);
      if (provided.length !== expected.length) return json(401, { error: "Incorrect password." });
      const passwordKey = await crypto.subtle.importKey("raw", expected, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
      const expectedCheck = await crypto.subtle.sign("HMAC", passwordKey, expected);
      if (!await crypto.subtle.verify("HMAC", passwordKey, expectedCheck, provided)) {
        return json(401, { error: "Incorrect password." });
      }
      const token = await createSession(env.DB, env.ADMIN_PASSWORD);
      return json(200, { ok: true }, { "Set-Cookie": sessionCookie(token, request) });
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      if (!checkOrigin(request)) return json(403, { error: "Request origin is not allowed." });
      await revokeSession(request, env.DB);
      return json(200, { ok: true }, { "Set-Cookie": "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    }

    const authenticated = await isAuthenticated(request, env.DB, env.ADMIN_PASSWORD);
    if (request.method === "GET" && url.pathname === "/api/session") {
      const config = authenticated ? await loadConfig(env.DB) : null;
      return json(200, {
        authenticated,
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
        channels: config?.channels,
        savedDestinations: config?.savedDestinations,
        savedChannels: config?.savedChannels,
        pollIntervalMinutes: config?.pollIntervalMinutes,
        messageTemplate: config?.messageTemplate,
      });
    }

    if (!authenticated) return json(401, { error: "Sign in to continue." });
    if (!checkOrigin(request)) return json(403, { error: "Request origin is not allowed." });

    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readJson(request);
      if (!POLL_INTERVAL_OPTIONS.includes(body.pollIntervalMinutes)) {
        throw new RequestError(`Choose a check interval: ${POLL_INTERVAL_OPTIONS.join(", ")} minutes.`);
      }
      await withConfigLock(env.DB, async (config) => {
        const template = typeof body.messageTemplate === "string" ? body.messageTemplate.trim() : config.messageTemplate;
        if (!template || template.length > 900) throw new RequestError("The Telegram message template must contain 1 to 900 characters.");
        if (!/\{title\}/.test(template) || !/\{url\}/.test(template)) {
          throw new RequestError("The message template must include both {title} and {url}.");
        }
        config.pollIntervalMinutes = body.pollIntervalMinutes;
        config.messageTemplate = template;
      });
      ctx.waitUntil(checkAllChannels(env.DB, env.TELEGRAM_BOT_TOKEN).catch((error) =>
        console.error(JSON.stringify({ message: "Check after settings update failed", error: String(error) }))));
      const config = await loadConfig(env.DB);
      return json(200, { pollIntervalMinutes: config.pollIntervalMinutes, messageTemplate: config.messageTemplate });
    }

    if (request.method === "PUT" && url.pathname === "/api/channels") {
      const body = await readJson(request);
      const channels = await withConfigLock(env.DB, async (config) => {
        config.channels = validateChannels(body.channels, config);
        return config.channels;
      });
      ctx.waitUntil(checkAllChannels(env.DB, env.TELEGRAM_BOT_TOKEN).catch((error) =>
        console.error(JSON.stringify({ message: "Check after route update failed", error: String(error) }))));
      return json(200, { channels });
    }

    if (request.method === "PUT" && url.pathname === "/api/saved-destinations") {
      const body = await readJson(request);
      const destinations = await withConfigLock(env.DB, async (config) => {
        config.savedDestinations = validateSavedDestinations(body.destinations, config);
        return config.savedDestinations;
      });
      return json(200, { destinations });
    }

    if (request.method === "POST" && url.pathname === "/api/telegram/lookup") {
      const body = await readJson(request);
      const { chatId } = validateDestination(body);
      try {
        const chat = await telegramRequest(env.TELEGRAM_BOT_TOKEN, "getChat", { chat_id: chatId });
        const name = chat.title || chat.first_name || chat.username;
        if (!name) throw new Error("Telegram found the chat but returned no display name.");
        return json(200, { chatId: String(chat.id), name, type: chat.type, username: chat.username || null, isForum: Boolean(chat.is_forum) });
      } catch (error) {
        if (error instanceof RequestError) throw error;
        return json(502, { error: `Telegram chat lookup failed: ${error.message} Make sure the bot is in the group and the chat ID is correct.` });
      }
    }

    if (request.method === "PUT" && url.pathname === "/api/saved-channels") {
      const body = await readJson(request);
      const channels = await withConfigLock(env.DB, async (config) => {
        config.savedChannels = validateSavedChannels(body.channels);
        return config.savedChannels;
      });
      return json(200, { channels });
    }

    if (request.method === "POST" && url.pathname === "/api/youtube/lookup") {
      const body = await readJson(request);
      const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
      if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
        throw new RequestError("Enter a YouTube channel ID starting with UC and containing 24 characters.");
      }
      const { entries, channelTitle } = await fetchFeed(channelId);
      return json(200, { channelId, channelTitle, latestVideo: entries[0] || null });
    }

    if (request.method === "POST" && url.pathname === "/api/check") {
      const channels = await checkAllChannels(env.DB, env.TELEGRAM_BOT_TOKEN);
      return json(200, { channels });
    }

    if (request.method === "POST" && url.pathname === "/api/test") {
      const destination = validateDestination(await readJson(request));
      const testedAt = new Date().toISOString();
      let testError = null;
      try {
        await telegramSend(env.TELEGRAM_BOT_TOKEN, destination, "<b>YouTube notifier test</b>\nThis Telegram destination is connected.");
      } catch (error) {
        testError = error instanceof Error ? error.message : String(error);
      }
      await withConfigLock(env.DB, async (config) => {
        for (const channel of config.channels) {
          const route = channel.destinations.find((item) =>
            item.chatId === destination.chatId && item.topicId === destination.topicId);
          if (route) {
            route.lastTestAt = testedAt;
            route.lastTestError = testError;
          }
        }
        const savedDestination = config.savedDestinations.find((item) =>
          item.chatId === destination.chatId && item.topicId === destination.topicId);
        if (savedDestination) {
          savedDestination.lastTestAt = testedAt;
          savedDestination.lastTestError = testError;
        }
      });
      if (testError) return json(502, { error: testError });
      return json(200, { ok: true, testedAt });
    }
    return json(404, { error: "Not found." });
  } catch (error) {
    const status = error instanceof RequestError ? 400 : 500;
    if (status === 500) console.error(JSON.stringify({ message: "Worker request failed", error: error instanceof Error ? error.message : String(error) }));
    return json(status, { error: error instanceof Error ? error.message : "Internal server error." });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleApi(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env).catch((error) =>
      console.error(JSON.stringify({ message: "Scheduled YouTube check failed", error: error instanceof Error ? error.message : String(error) }))));
  },
};
