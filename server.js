const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const POLL_INTERVAL_OPTIONS = [1, 2, 5, 10, 15, 30, 60];
const DEFAULT_MESSAGE_TEMPLATE = "<b>🔥 NEW UPLOAD WATCH NOW 🔥</b>\n━━━━━━━━━━━━━━━━\n🎬 {title}\n📺 {channel}\n📅 {published}\n<a href=\"{url}\">▶ Watch on YouTube</a>";
const sessions = new Map();

let config = {
  channels: [],
  savedDestinations: [],
  savedChannels: [],
  pollIntervalMinutes: 2,
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
};
let polling = false;
let pollTimer = null;

class RequestError extends Error {}

async function loadConfig() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
    config.channels = Array.isArray(saved.channels) ? saved.channels : [];
    config.savedDestinations = Array.isArray(saved.savedDestinations) ? saved.savedDestinations : [];
    config.pollIntervalMinutes = POLL_INTERVAL_OPTIONS.includes(saved.pollIntervalMinutes)
      ? saved.pollIntervalMinutes
      : 2;
    config.messageTemplate = typeof saved.messageTemplate === "string" && saved.messageTemplate.trim()
      ? saved.messageTemplate
      : DEFAULT_MESSAGE_TEMPLATE;
    const hasSavedChannels = Array.isArray(saved.savedChannels);
    config.savedChannels = hasSavedChannels ? saved.savedChannels : config.channels.map((channel) => ({
        id: crypto.randomUUID(),
        name: channel.channelTitle || channel.id,
        channelId: channel.id,
      }));
    let recoveredDestinationTests = false;
    for (const destination of config.savedDestinations) {
      if (destination.lastTestAt) continue;
      const routeTest = latestRouteTestForDestination(destination);
      if (!routeTest) continue;
      destination.lastTestAt = routeTest.lastTestAt;
      destination.lastTestError = routeTest.lastTestError || null;
      recoveredDestinationTests = true;
    }
    if (!hasSavedChannels || recoveredDestinationTests) await saveConfig();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveConfig();
  }
}

async function saveConfig() {
  const temporaryFile = `${CONFIG_FILE}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryFile, CONFIG_FILE);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new RequestError("Request body is too large.");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new RequestError("Request body must be valid JSON.");
  }
}

function sessionFrom(request) {
  const cookie = request.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return match[1];
}

function isAuthenticated(request) {
  return Boolean(sessionFrom(request));
}

function scheduleChannelChecks() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    void checkAllChannels().catch((error) => console.error("Scheduled YouTube check failed:", error));
  }, config.pollIntervalMinutes * 60_000);
}

function checkOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function destinationPlatform(destination) {
  return destination.platform ?? "telegram";
}

function destinationKey(destination) {
  const platform = destinationPlatform(destination);
  return platform === "discord"
    ? `discord:${destination.webhookUrl}`
    : `telegram:${destination.chatId}:${destination.topicId || ""}`;
}

function validateDestination(destination) {
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    throw new RequestError("Each notification destination must be an object.");
  }
  const platform = destinationPlatform(destination);
  if (platform === "discord") {
    const webhookUrl = typeof destination.webhookUrl === "string" ? destination.webhookUrl.trim() : "";
    let parsedUrl;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      throw new RequestError("Enter a valid Discord webhook URL.");
    }
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "discord.com" ||
      parsedUrl.port ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.search ||
      parsedUrl.hash ||
      !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(parsedUrl.pathname)
    ) {
      throw new RequestError("Use a Discord webhook URL from discord.com.");
    }
    return { platform, webhookUrl: parsedUrl.toString() };
  }
  if (platform !== "telegram") {
    throw new RequestError("Choose Telegram or Discord for each notification destination.");
  }
  const chatId = typeof destination.chatId === "string" ? destination.chatId.trim() : "";
  const topicId = typeof destination.topicId === "string" ? destination.topicId.trim() : "";
  if (!/^(?:-?\d+|@[A-Za-z0-9_]{5,32})$/.test(chatId)) {
    throw new RequestError("Telegram chat IDs must be numeric (including -100 group IDs) or a @channel username.");
  }
  if (topicId && !/^[1-9]\d*$/.test(topicId)) {
    throw new RequestError("Topic IDs must be positive numbers, or left blank.");
  }
  return { platform, chatId, topicId };
}

function latestRouteTestForDestination(destination) {
  return config.channels
    .flatMap((channel) => channel.destinations || [])
    .filter((item) =>
      destinationKey(item) === destinationKey(destination) &&
      typeof item.lastTestAt === "string" &&
      Number.isFinite(Date.parse(item.lastTestAt)))
    .sort((left, right) => Date.parse(right.lastTestAt) - Date.parse(left.lastTestAt))[0] || null;
}

function validateSavedDestinations(input) {
  if (!Array.isArray(input) || input.length > 100) {
    throw new RequestError("Save up to 100 notification destinations.");
  }

  const ids = new Set();
  const destinationKeys = new Set();
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
    const key = destinationKey(destination);
    if (destinationKeys.has(key)) {
      throw new RequestError("A destination can only be saved once. Remove the duplicate saved destination.");
    }
    destinationKeys.add(key);
    const existingById = config.savedDestinations.find((savedDestination) => savedDestination.id === id);
    const existingForDestination = config.savedDestinations.find((savedDestination) =>
      destinationKey(savedDestination) === key);
    const previousTest = existingById
      ? destinationKey(existingById) === key
        ? existingById
        : null
      : existingForDestination;
    const recoveredTest = previousTest?.lastTestAt
      ? previousTest
      : latestRouteTestForDestination(destination);
    return {
      id,
      name,
      ...destination,
      lastTestAt: recoveredTest
        ? recoveredTest.lastTestAt || null
        : existingById
          ? null
          : typeof item.lastTestAt === "string" ? item.lastTestAt : null,
      lastTestError: recoveredTest
        ? recoveredTest.lastTestError || null
        : existingById
          ? null
          : typeof item.lastTestError === "string" ? item.lastTestError : null,
    };
  });
}

function validateSavedChannels(input) {
  if (!Array.isArray(input) || input.length > 100) {
    throw new RequestError("Save up to 100 YouTube channels.");
  }

  const ids = new Set();
  const channelIds = new Set();
  return input.map((item) => {
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

function validateChannels(input) {
  if (!Array.isArray(input) || input.length > 100) {
    throw new RequestError("Add up to 100 YouTube channels.");
  }

  const ids = new Set();
  return input.map((channel) => {
    const id = typeof channel.id === "string" ? channel.id.trim() : "";
    if (!/^UC[a-zA-Z0-9_-]{22}$/.test(id)) {
      throw new RequestError("Each YouTube channel ID must start with UC and contain 24 characters.");
    }
    if (ids.has(id)) {
      throw new RequestError("Each YouTube channel can have only one notification route. Add destinations to its existing route.");
    }
    ids.add(id);

    if (!Array.isArray(channel.destinations) || channel.destinations.length === 0 || channel.destinations.length > 30) {
      throw new RequestError("Each channel needs between 1 and 30 notification destinations.");
    }

    const destinationKeys = new Set();
    const destinations = channel.destinations.map((destination) => {
      const validated = validateDestination(destination);
      const key = destinationKey(validated);
      if (destinationKeys.has(key)) throw new RequestError("A notification destination is duplicated for this channel.");
      destinationKeys.add(key);
      return validated;
    });

    const current = config.channels.find((existing) => existing.id === id);
    return {
      id,
      destinations: destinations.map((destination) => {
        const previous = current?.destinations.find((item) =>
          destinationKey(item) === destinationKey(destination));
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

async function telegramSend(destination, text) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("Set TELEGRAM_BOT_TOKEN in the environment first.");
  const payload = {
    chat_id: destination.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };
  if (destination.topicId) payload.message_thread_id = Number(destination.topicId);

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram returned HTTP ${response.status}.`);
  }
}

async function telegramSendPhoto(destination, photo, caption) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("Set TELEGRAM_BOT_TOKEN in the environment first.");
  const payload = {
    chat_id: destination.chatId,
    photo,
    caption,
    parse_mode: "HTML",
  };
  if (destination.topicId) payload.message_thread_id = Number(destination.topicId);

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram returned HTTP ${response.status}.`);
  }
}

async function discordSend(destination, payload) {
  let response;
  try {
    response = await fetch(`${destination.webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Discord webhook request failed. Check the webhook and network connection.");
  }
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}.`);
}

function discordVideoPayload(channel, video) {
  const publishedAt = video.published && !Number.isNaN(new Date(video.published).getTime())
    ? new Date(video.published).toISOString()
    : null;
  const description = `New upload from **${channel.channelTitle || "YouTube channel"}**` +
    (publishedAt ? ` · ${new Date(publishedAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}` : "");
  return {
    embeds: [{
      title: video.title.slice(0, 256),
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
      description: description.slice(0, 4096),
      color: 0xff0000,
      ...(publishedAt ? { timestamp: publishedAt } : {}),
      image: { url: `https://i.ytimg.com/vi/${encodeURIComponent(video.id)}/hqdefault.jpg` },
    }],
    allowed_mentions: { parse: [] },
  };
}

async function sendDestination(destination, channel, video) {
  if (destinationPlatform(destination) === "discord") {
    await discordSend(destination, discordVideoPayload(channel, video));
    return;
  }
  const caption = formatVideoMessage(config.messageTemplate, channel, video);
  const thumbnail = `https://i.ytimg.com/vi/${encodeURIComponent(video.id)}/hqdefault.jpg`;
  await telegramSendPhoto(destination, thumbnail, caption);
}

async function sendTestDestination(destination) {
  if (destinationPlatform(destination) === "discord") {
    await discordSend(destination, {
      content: "TubeSignal test message — this Discord destination is connected.",
      allowed_mentions: { parse: [] },
    });
    return;
  }
  await telegramSend(destination, "<b>YouTube notifier test</b>\nThis Telegram destination is connected.");
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
  return template.replace(/\{(title|channel|published|url|videoId)\}/g, (_, key) =>
    escapeHtml(values[key]));
}

async function telegramApi(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new RequestError("Set TELEGRAM_BOT_TOKEN in the environment before looking up Telegram chats.");
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram returned HTTP ${response.status}.`);
  }
  return result.result;
}

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (code[0] !== "#") return named[code.toLowerCase()] || entity;
    const number = code[1].toLowerCase() === "x"
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(number) && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
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

async function checkChannel(channel) {
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
        await sendDestination(destination, channel, newest);
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
        await sendDestination(destination, channel, entry);
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
    channel.lastError = error.message;
    console.error(`Failed to check channel ${channel.id}:`, error.message);
  }
}

async function checkAllChannels() {
  if (polling) return;
  polling = true;
  try {
    for (const channel of config.channels) await checkChannel(channel);
    await saveConfig();
  } finally {
    polling = false;
  }
}

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requestedPath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    }[path.extname(filePath)] || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "same-origin",
    });
    response.end(content);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      await serveStatic(request, response, url.pathname);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!checkOrigin(request)) return sendJson(response, 403, { error: "Request origin is not allowed." });
      if (!ADMIN_PASSWORD) return sendJson(response, 503, { error: "Set ADMIN_PASSWORD in the environment before signing in." });
      const { password } = await readJson(request);
      const provided = Buffer.from(typeof password === "string" ? password : "");
      const expected = Buffer.from(ADMIN_PASSWORD);
      if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        return sendJson(response, 401, { error: "Incorrect password." });
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
      response.writeHead(200, {
        "Set-Cookie": `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      });
      return response.end(JSON.stringify({ ok: true }));
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      if (!checkOrigin(request)) return sendJson(response, 403, { error: "Request origin is not allowed." });
      const token = sessionFrom(request);
      if (token) sessions.delete(token);
      response.writeHead(200, {
        "Set-Cookie": "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      });
      return response.end(JSON.stringify({ ok: true }));
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      return sendJson(response, 200, {
        authenticated: isAuthenticated(request),
        telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN),
        channels: isAuthenticated(request) ? config.channels : undefined,
        savedDestinations: isAuthenticated(request) ? config.savedDestinations : undefined,
        savedChannels: isAuthenticated(request) ? config.savedChannels : undefined,
        pollIntervalMinutes: isAuthenticated(request) ? config.pollIntervalMinutes : undefined,
        messageTemplate: isAuthenticated(request) ? config.messageTemplate : undefined,
      });
    }

    if (!url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found." });
    if (!isAuthenticated(request)) return sendJson(response, 401, { error: "Sign in to continue." });
    if (!checkOrigin(request)) return sendJson(response, 403, { error: "Request origin is not allowed." });

    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readJson(request);
      if (!POLL_INTERVAL_OPTIONS.includes(body.pollIntervalMinutes)) {
        throw new RequestError(`Choose a check interval: ${POLL_INTERVAL_OPTIONS.join(", ")} minutes.`);
      }
      const messageTemplate = typeof body.messageTemplate === "string"
        ? body.messageTemplate.trim()
        : config.messageTemplate;
      if (!messageTemplate || messageTemplate.length > 900) {
        throw new RequestError("The Telegram message template must contain 1 to 900 characters.");
      }
      if (!/\{title\}/.test(messageTemplate) || !/\{url\}/.test(messageTemplate)) {
        throw new RequestError("The message template must include both {title} and {url}.");
      }
      config.pollIntervalMinutes = body.pollIntervalMinutes;
      config.messageTemplate = messageTemplate;
      await saveConfig();
      scheduleChannelChecks();
      void checkAllChannels().catch((error) => console.error("YouTube check after settings update failed:", error));
      return sendJson(response, 200, {
        pollIntervalMinutes: config.pollIntervalMinutes,
        messageTemplate: config.messageTemplate,
      });
    }

    if (request.method === "PUT" && url.pathname === "/api/channels") {
      const body = await readJson(request);
      config.channels = validateChannels(body.channels);
      await saveConfig();
      void checkAllChannels().catch((error) => console.error("YouTube check after route update failed:", error));
      return sendJson(response, 200, { channels: config.channels });
    }

    if (request.method === "PUT" && url.pathname === "/api/saved-destinations") {
      const body = await readJson(request);
      config.savedDestinations = validateSavedDestinations(body.destinations);
      await saveConfig();
      return sendJson(response, 200, { destinations: config.savedDestinations });
    }

    if (request.method === "POST" && url.pathname === "/api/telegram/lookup") {
      const body = await readJson(request);
      const { chatId } = validateDestination(body);
      try {
        const chat = await telegramApi("getChat", { chat_id: chatId });
        const name = chat.title || chat.first_name || chat.username;
        if (!name) {
          throw new Error("Telegram found the chat but returned no display name.");
        }
        return sendJson(response, 200, {
          chatId: String(chat.id),
          name,
          type: chat.type,
          username: chat.username || null,
          isForum: Boolean(chat.is_forum),
        });
      } catch (error) {
        if (error instanceof RequestError) throw error;
        return sendJson(response, 502, {
          error: `Telegram chat lookup failed: ${error.message} Make sure the bot is in the group and the chat ID is correct.`,
        });
      }
    }

    if (request.method === "PUT" && url.pathname === "/api/saved-channels") {
      const body = await readJson(request);
      config.savedChannels = validateSavedChannels(body.channels);
      await saveConfig();
      return sendJson(response, 200, { channels: config.savedChannels });
    }

    if (request.method === "POST" && url.pathname === "/api/youtube/lookup") {
      const body = await readJson(request);
      const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
      if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
        throw new RequestError("Enter a YouTube channel ID starting with UC and containing 24 characters.");
      }
      const { entries, channelTitle } = await fetchFeed(channelId);
      return sendJson(response, 200, {
        channelId,
        channelTitle,
        latestVideo: entries[0] || null,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/check") {
      await checkAllChannels();
      return sendJson(response, 200, { channels: config.channels });
    }

    if (request.method === "POST" && url.pathname === "/api/test") {
      const destination = validateDestination(await readJson(request));
      let testError = null;
      try {
        await sendTestDestination(destination);
      } catch (error) {
        testError = error instanceof Error ? error.message : String(error);
      }
      const testedAt = new Date().toISOString();
      let saved = false;
      for (const channel of config.channels) {
        const configuredDestination = channel.destinations.find((item) =>
          destinationKey(item) === destinationKey(destination));
        if (!configuredDestination) continue;
        configuredDestination.lastTestAt = testedAt;
        configuredDestination.lastTestError = testError;
        saved = true;
      }
      const savedDestination = config.savedDestinations.find((item) =>
        destinationKey(item) === destinationKey(destination));
      if (savedDestination) {
        savedDestination.lastTestAt = testedAt;
        savedDestination.lastTestError = testError;
        saved = true;
      }
      if (saved) await saveConfig();
      if (testError) return sendJson(response, 502, { error: testError });
      return sendJson(response, 200, { ok: true, testedAt });
    }

    return sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    const status = error instanceof RequestError ? 400 : 500;
    if (status === 500) console.error("Request failed:", error);
    return sendJson(response, status, { error: error.message || "Internal server error." });
  }
});

async function start() {
  await loadConfig();
  server.listen(PORT, HOST, () => {
    console.log(`TubeSignal is running at http://${HOST}:${PORT}`);
    if (!ADMIN_PASSWORD) console.warn("Set ADMIN_PASSWORD before using the dashboard.");
    if (!TELEGRAM_BOT_TOKEN) console.warn("Set TELEGRAM_BOT_TOKEN to send Telegram messages.");
    void checkAllChannels().catch((error) => console.error("Initial YouTube check failed:", error));
  });
  scheduleChannelChecks();
}

start().catch((error) => {
  console.error("Could not start the app:", error);
  process.exitCode = 1;
});
