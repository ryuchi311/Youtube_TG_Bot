const loginView = document.querySelector("#login-view");
const dashboardView = document.querySelector("#dashboard-view");
const channelList = document.querySelector("#channel-list");
const feedback = document.querySelector("#feedback");
const logoutButton = document.querySelector("#logout-button");
let savedDestinations = [];
let savedChannels = [];
let pollIntervalMinutes = 2;
const DEFAULT_MESSAGE_TEMPLATE = `<b>🔥 NEW UPLOAD WATCH NOW 🔥</b>
━━━━━━━━━━━━━━━━
🎬 {title}
📺 {channel}
📅 {published}
<a href="{url}">▶ Watch on YouTube</a>`;

function renderPollInterval(minutes) {
  pollIntervalMinutes = minutes;
  document.querySelector("#poll-interval").value = String(minutes);
  document.querySelector("#poll-summary").textContent = `Checks every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function updateSetupOverview() {
  const channels = document.querySelectorAll(".saved-channel-row").length;
  const destinations = document.querySelectorAll(".saved-destination-row").length;
  const routes = channelList.querySelectorAll(".channel-card").length;
  document.querySelector("#route-section-count").textContent = `${routes} ${routes === 1 ? "route" : "routes"}`;
  const values = [
    ["setup-channel-count", channels, "channel", "channels"],
    ["setup-destination-count", destinations, "destination", "destinations"],
    ["setup-route-count", routes, "route", "routes"],
  ];
  for (const [id, count, singular, plural] of values) {
    document.querySelector(`#${id}`).textContent = `${count} ${count === 1 ? singular : plural}`;
  }
  for (const [id, count] of [
    ["setup-channel-state", channels],
    ["setup-destination-state", destinations],
    ["setup-route-state", routes],
  ]) {
    const state = document.querySelector(`#${id}`);
    state.textContent = count ? "Ready" : "Add";
    state.classList.toggle("is-done", count > 0);
  }
  document.querySelector("#route-empty-state").classList.toggle("hidden", routes > 0);
}

function renderMessageTemplate(template) {
  document.querySelector("#message-template").value = template || DEFAULT_MESSAGE_TEMPLATE;
}

function setMonitorStatus(title, detail, state = "ready") {
  const status = document.querySelector("#monitor-status");
  status.classList.toggle("is-error", state === "error");
  status.classList.toggle("is-warning", state === "warning");
  document.querySelector("#monitor-title").textContent = title;
  document.querySelector("#monitor-detail").textContent = detail;
}

function updateHealth(channels, telegramConfigured) {
  const checkedChannels = channels.filter((channel) => channel.lastCheckedAt);
  const failures = channels.filter((channel) => channel.lastError);
  const failedTests = channels.flatMap((channel) =>
    channel.destinations
      .filter((destination) => destination.lastTestError)
      .map((destination) => ({ channel, destination })));
  const latestCheck = checkedChannels
    .map((channel) => new Date(channel.lastCheckedAt))
    .sort((a, b) => b - a)[0];

  for (const card of channelList.querySelectorAll(".channel-card")) {
    const id = card.querySelector(".channel-id").value.trim();
    const channel = channels.find((item) => item.id === id);
    const meta = card.querySelector(".channel-meta");
    const latestUpload = card.querySelector(".latest-upload");
    meta.classList.toggle("has-error", Boolean(channel?.lastError));
    latestUpload.replaceChildren();
    if (!channel) {
      meta.textContent = "";
    } else if (channel.lastError) {
      meta.textContent = `Check or delivery failed: ${channel.lastError}`;
    } else if (channel.lastCheckedAt) {
      meta.textContent = `YouTube feed checked ${new Date(channel.lastCheckedAt).toLocaleString()}`;
    } else {
      meta.textContent = "Waiting for the first YouTube feed check";
    }
    if (channel?.latestVideoId && channel.latestVideoTitle) {
      const label = document.createElement("span");
      label.className = "latest-upload-label";
      label.textContent = "LATEST UPLOAD";
      const link = document.createElement("a");
      link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(channel.latestVideoId)}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = channel.latestVideoTitle;
      latestUpload.append(label, link);
      if (channel.latestVideoPublished) {
        const date = new Date(channel.latestVideoPublished);
        if (!Number.isNaN(date.getTime())) {
          const published = document.createElement("span");
          published.className = "latest-upload-date";
          published.textContent = date.toLocaleString();
          latestUpload.append(published);
        }
      }
    }
  }

  if (channels.length === 0) {
    setMonitorStatus("Not monitoring yet", "Add and save a YouTube channel to start checking for uploads.", "warning");
    return;
  }

  if (failures.length > 0) {
    const failure = failures[0];
    const title = failure.channelTitle || failure.id;
    const more = failures.length > 1 ? ` (${failures.length} channels need attention)` : "";
    setMonitorStatus(
      "Needs attention",
      `${title}: ${failure.lastError}${more}`,
      "error",
    );
    return;
  }

  if (failedTests.length > 0) {
    const { channel, destination } = failedTests[0];
    const channelName = channel.channelTitle || channel.id;
    const topic = destination.topicId ? `, topic ${destination.topicId}` : "";
    setMonitorStatus(
      "Telegram delivery needs attention",
      `${channelName} → ${destination.chatId}${topic}: ${destination.lastTestError}`,
      "error",
    );
    return;
  }

  if (!latestCheck) {
    setMonitorStatus("Waiting for first check", `The monitor checks YouTube every ${pollIntervalMinutes} minute${pollIntervalMinutes === 1 ? "" : "s"}.`, "warning");
    return;
  }

  const minutesAgo = Math.max(0, Math.floor((Date.now() - latestCheck.getTime()) / 60_000));
  const recency = minutesAgo === 0 ? "just now" : `${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago`;
  if (!telegramConfigured) {
    setMonitorStatus("YouTube checks active · Telegram not configured", `Last feed check ${recency}. Add TELEGRAM_BOT_TOKEN to enable delivery.`, "warning");
  } else if (minutesAgo > Math.max(pollIntervalMinutes + 2, 5)) {
    setMonitorStatus("Check may be delayed", `Last YouTube feed check was ${recency}. Expected every ${pollIntervalMinutes} minute${pollIntervalMinutes === 1 ? "" : "s"}. Use Check now or verify the server is running.`, "warning");
  } else {
    const verified = channels.reduce((count, channel) =>
      count + channel.destinations.filter((destination) => destination.lastTestAt && !destination.lastTestError).length, 0);
    const deliveryNote = verified ? ` ${verified} Telegram route${verified === 1 ? "" : "s"} test successfully.` : " Test each Telegram route to verify delivery.";
    setMonitorStatus("Monitoring active", `Checked ${checkedChannels.length} channel${checkedChannels.length === 1 ? "" : "s"} ${recency}.${deliveryNote}`, verified ? "ready" : "warning");
  }
}

function updateSavedDestinationCount() {
  const count = document.querySelectorAll(".saved-destination-row").length;
  document.querySelector("#saved-count").textContent = `${count} saved`;
  updateSetupOverview();
}

function renderSavedDestinationTestStatus(row) {
  const status = row.querySelector(".saved-destination-status");
  const testedAt = row.dataset.lastTestAt;
  const testError = row.dataset.lastTestError;
  status.replaceChildren();
  status.classList.toggle("has-error", Boolean(testError));
  const badge = document.createElement("span");
  badge.className = `destination-test-badge ${testError ? "is-failed" : testedAt ? "is-passed" : "is-untested"}`;
  badge.textContent = testError ? "FAILED" : testedAt ? "PASSED" : "NOT TESTED";
  status.append(badge);
  if (testError) {
    status.append(document.createTextNode(testError));
  } else if (testedAt) {
    status.append(document.createTextNode(`Test message sent ${new Date(testedAt).toLocaleString()}.`));
  } else {
    status.append(document.createTextNode("Send a test message to verify this destination."));
  }
}

function addSavedDestination(destination = {}) {
  const row = document.querySelector("#saved-destination-template").content.firstElementChild.cloneNode(true);
  row.dataset.id = destination.id || crypto.randomUUID();
  row.dataset.lastTestAt = destination.lastTestAt || "";
  row.dataset.lastTestError = destination.lastTestError || "";
  row.querySelector(".saved-name").value = destination.name || "";
  row.querySelector(".saved-chat-id").value = destination.chatId || "";
  row.querySelector(".saved-topic-id").value = destination.topicId || "";
  row.querySelector(".test-saved-destination").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const chatId = row.querySelector(".saved-chat-id").value.trim();
    const topicId = row.querySelector(".saved-topic-id").value.trim();
    button.disabled = true;
    row.dataset.lastTestError = "";
    row.querySelector(".saved-destination-status").textContent = "Sending test message…";
    try {
      const result = await api("/api/test", {
        method: "POST",
        body: JSON.stringify({ chatId, topicId }),
      });
      row.dataset.lastTestAt = result.testedAt;
      row.dataset.lastTestError = "";
      renderSavedDestinationTestStatus(row);
      showFeedback("Test message sent to the saved Telegram destination.");
    } catch (error) {
      row.dataset.lastTestAt = new Date().toISOString();
      row.dataset.lastTestError = error.message;
      renderSavedDestinationTestStatus(row);
      showFeedback(`Telegram test failed: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
  row.querySelector(".fetch-telegram-details").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const chatId = row.querySelector(".saved-chat-id").value.trim();
    const status = row.querySelector(".saved-destination-status");
    if (!chatId) {
      status.textContent = "Enter a Telegram group ID first.";
      status.classList.add("has-error");
      return;
    }
    button.disabled = true;
    status.textContent = "Looking up Telegram chat…";
    status.classList.remove("has-error");
    try {
      const result = await api("/api/telegram/lookup", {
        method: "POST",
        body: JSON.stringify({ chatId, topicId: row.querySelector(".saved-topic-id").value.trim() }),
      });
      row.querySelector(".saved-name").value = result.name;
      const forumStatus = result.isForum ? "Forum group" : result.type;
      const topicId = row.querySelector(".saved-topic-id").value.trim();
      status.textContent = `Found ${result.name} (${forumStatus})${result.username ? ` · @${result.username}` : ""}${topicId ? ` · topic ${topicId} will be used` : ""}.`;
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("has-error");
    } finally {
      button.disabled = false;
    }
  });
  renderSavedDestinationTestStatus(row);
  row.querySelector(".remove-saved-destination").addEventListener("click", () => {
    const name = row.querySelector(".saved-name").value.trim() || "this Telegram destination";
    if (!window.confirm(`Remove ${name} from the saved destinations? This change takes effect when you save destinations.`)) return;
    row.remove();
    updateSavedDestinationCount();
    refreshAllRouteDestinations();
  });
  document.querySelector("#saved-destination-list").append(row);
  updateSavedDestinationCount();
}

function collectSavedDestinations() {
  return [...document.querySelectorAll(".saved-destination-row")].map((row) => ({
    id: row.dataset.id,
    name: row.querySelector(".saved-name").value.trim(),
    chatId: row.querySelector(".saved-chat-id").value.trim(),
    topicId: row.querySelector(".saved-topic-id").value.trim(),
    lastTestAt: row.dataset.lastTestAt || null,
    lastTestError: row.dataset.lastTestError || null,
  }));
}

function destinationKey(destination) {
  return `${destination.chatId}:${destination.topicId || ""}`;
}

function selectedRouteDestinations(card) {
  return [...card.querySelectorAll(".route-destination-option")]
    .filter((option) => option.querySelector(".route-destination-checkbox").checked)
    .map((option) => ({
      chatId: option.dataset.chatId,
      topicId: option.dataset.topicId,
      lastVideoId: option.dataset.lastVideoId || null,
      lastNotifiedAt: option.dataset.lastNotifiedAt || null,
      lastNotifiedVideoTitle: option.dataset.lastNotifiedVideoTitle || null,
      lastTestAt: option.dataset.lastTestAt || null,
      lastTestError: option.dataset.lastTestError || null,
    }));
}

function updateRouteDestinationCount(card) {
  const count = card.querySelectorAll(".route-destination-checkbox:checked").length;
  card.querySelector(".selected-destination-count").textContent = `${count} selected`;
}

function updateRouteDestinationStatus(option) {
  const status = option.querySelector(".route-destination-status");
  const testError = option.dataset.lastTestError;
  const testAt = option.dataset.lastTestAt;
  const notifiedAt = option.dataset.lastNotifiedAt;
  const notifiedTitle = option.dataset.lastNotifiedVideoTitle;
  status.replaceChildren();

  const testBadge = document.createElement("span");
  if (testError) {
    testBadge.className = "destination-test-badge is-failed";
    testBadge.textContent = "FAILED";
    status.append(testBadge, document.createTextNode(` ${testError}`));
  } else if (testAt) {
    testBadge.className = "destination-test-badge is-passed";
    testBadge.textContent = "PASSED";
    status.append(testBadge);
  } else {
    testBadge.className = "destination-test-badge is-untested";
    testBadge.textContent = "NOT TESTED";
    status.append(testBadge);
  }

  if (notifiedAt && notifiedTitle) {
    const delivery = document.createElement("span");
    delivery.className = "route-delivery-status";
    delivery.textContent = `Latest sent: ${notifiedTitle} · ${new Date(notifiedAt).toLocaleString()}`;
    status.append(delivery);
  }
}

function refreshRouteDestinations(card, selected = selectedRouteDestinations(card)) {
  const unique = new Map();
  for (const destination of savedDestinations) {
    const key = destinationKey(destination);
    if (!unique.has(key)) unique.set(key, destination);
  }
  for (const destination of selected) {
    const key = destinationKey(destination);
    if (!unique.has(key)) {
      unique.set(key, { ...destination, name: `Unlisted group ${destination.chatId}` });
    }
  }

  const selectedByKey = new Map(selected.map((destination) => [destinationKey(destination), destination]));
  const list = card.querySelector(".destination-list");
  list.replaceChildren();
  for (const destination of unique.values()) {
    const option = document.querySelector("#route-destination-template").content.firstElementChild.cloneNode(true);
    const key = destinationKey(destination);
    const saved = savedDestinations.find((item) => destinationKey(item) === key);
    const selectedDestination = selectedByKey.get(key);
    option.dataset.chatId = destination.chatId;
    option.dataset.topicId = destination.topicId || "";
    option.dataset.lastVideoId = selectedDestination?.lastVideoId || "";
    option.dataset.lastNotifiedAt = selectedDestination?.lastNotifiedAt || "";
    option.dataset.lastNotifiedVideoTitle = selectedDestination?.lastNotifiedVideoTitle || "";
    option.dataset.lastTestAt = selectedDestination?.lastTestAt || "";
    option.dataset.lastTestError = selectedDestination?.lastTestError || "";
    option.querySelector(".route-destination-checkbox").checked = Boolean(selectedDestination);

    const label = option.querySelector(".route-destination-label");
    label.querySelector(".route-destination-name").textContent =
      `${saved?.name || destination.name || `Telegram group ${destination.chatId}`}${destination.topicId ? ` · Topic ${destination.topicId}` : " · General chat"}`;
    option.querySelector(".route-destination-checkbox").addEventListener("change", (event) => {
      const selected = card.querySelectorAll(".route-destination-checkbox:checked");
      if (event.currentTarget.checked && selected.length > 30) {
        event.currentTarget.checked = false;
        showFeedback("A channel can have at most 30 Telegram destinations.", true);
      }
      updateRouteDestinationCount(card);
    });
    option.querySelector(".test-route-destination").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api("/api/test", {
          method: "POST",
          body: JSON.stringify({ chatId: destination.chatId, topicId: destination.topicId || "" }),
        });
        option.dataset.lastTestAt = new Date().toISOString();
        option.dataset.lastTestError = "";
        updateRouteDestinationStatus(option);
        showFeedback("Test message sent to Telegram.");
      } catch (error) {
        option.dataset.lastTestAt = new Date().toISOString();
        option.dataset.lastTestError = error.message;
        updateRouteDestinationStatus(option);
        showFeedback(`Telegram test failed: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
    updateRouteDestinationStatus(option);
    list.append(option);
  }
  updateRouteDestinationCount(card);
}

function refreshAllRouteDestinations() {
  for (const card of channelList.querySelectorAll(".channel-card")) {
    refreshRouteDestinations(card);
  }
}

function renderSavedDestinations(destinations) {
  savedDestinations = destinations;
  const list = document.querySelector("#saved-destination-list");
  list.replaceChildren();
  destinations.forEach(addSavedDestination);
  refreshAllRouteDestinations();
}

function updateSavedChannelCount() {
  const count = document.querySelectorAll(".saved-channel-row").length;
  document.querySelector("#saved-channel-count").textContent = `${count} saved`;
  updateSetupOverview();
}

function addSavedChannel(channel = {}) {
  const row = document.querySelector("#saved-channel-template").content.firstElementChild.cloneNode(true);
  row.dataset.id = channel.id || crypto.randomUUID();
  row.querySelector(".saved-channel-name").value = channel.name || "";
  row.querySelector(".saved-channel-id").value = channel.channelId || "";
  row.querySelector(".fetch-channel-details").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const channelId = row.querySelector(".saved-channel-id").value.trim();
    const status = row.querySelector(".saved-channel-status");
    if (!channelId) {
      status.textContent = "Enter a YouTube channel ID first.";
      status.classList.add("has-error");
      return;
    }
    button.disabled = true;
    status.textContent = "Looking up channel…";
    status.classList.remove("has-error");
    try {
      const result = await api("/api/youtube/lookup", {
        method: "POST",
        body: JSON.stringify({ channelId }),
      });
      row.querySelector(".saved-channel-name").value = result.channelTitle;
      status.textContent = result.latestVideo
        ? `Found ${result.channelTitle}. Latest upload: ${result.latestVideo.title}`
        : `Found ${result.channelTitle}. No recent uploads in the public feed.`;
      refreshChannelPickers();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("has-error");
    } finally {
      button.disabled = false;
    }
  });
  row.querySelector(".remove-saved-channel").addEventListener("click", () => {
    const name = row.querySelector(".saved-channel-name").value.trim() || "this YouTube channel";
    if (!window.confirm(`Remove ${name} from the saved channels? This change takes effect when you save channels.`)) return;
    row.remove();
    updateSavedChannelCount();
    refreshChannelPickers();
  });
  document.querySelector("#saved-channel-list").append(row);
  updateSavedChannelCount();
}

function collectSavedChannels() {
  return [...document.querySelectorAll(".saved-channel-row")].map((row) => ({
    id: row.dataset.id,
    name: row.querySelector(".saved-channel-name").value.trim(),
    channelId: row.querySelector(".saved-channel-id").value.trim(),
  }));
}

function refreshChannelPickers() {
  const cards = [...channelList.querySelectorAll(".channel-card")];
  for (const card of cards) {
    const select = card.querySelector(".saved-channel-select");
    const channelId = card.querySelector(".channel-id").value.trim();
    const usedByOtherCards = new Set(cards
      .filter((otherCard) => otherCard !== card)
      .map((otherCard) => otherCard.querySelector(".channel-id").value.trim())
      .filter(Boolean));
    select.replaceChildren(new Option("Choose a saved channel…", ""));
    for (const channel of savedChannels) {
      const option = new Option(`${channel.name} (${channel.channelId})`, channel.id);
      option.disabled = usedByOtherCards.has(channel.channelId);
      select.add(option);
    }
    select.value = savedChannels.find((channel) => channel.channelId === channelId)?.id || "";
    card.querySelector(".channel-duplicate-warning").classList.toggle(
      "hidden",
      !channelId || !usedByOtherCards.has(channelId),
    );
  }
}

function renderSavedChannels(channels) {
  savedChannels = channels;
  const list = document.querySelector("#saved-channel-list");
  list.replaceChildren();
  channels.forEach(addSavedChannel);
  updateSavedChannelCount();
  refreshChannelPickers();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
  feedback.classList.remove("hidden");
  window.clearTimeout(showFeedback.timeout);
  if (!isError) showFeedback.timeout = window.setTimeout(() => feedback.classList.add("hidden"), 5000);
}

function showDashboard(authenticated) {
  loginView.classList.toggle("hidden", authenticated);
  dashboardView.classList.toggle("hidden", !authenticated);
  logoutButton.classList.toggle("hidden", !authenticated);
  document.body.classList.toggle("dashboard-active", authenticated);
}

function addChannel(channel = {}) {
  const card = document.querySelector("#channel-template").content.firstElementChild.cloneNode(true);
  const channelId = card.querySelector(".channel-id");
  const channelSelect = card.querySelector(".saved-channel-select");
  channelId.value = channel.id || "";
  channelId.addEventListener("input", () => {
    card.querySelector(".channel-name").textContent = channelId.value.trim() || "YouTube channel";
    refreshChannelPickers();
  });
  channelSelect.addEventListener("change", (event) => {
    const saved = savedChannels.find((item) => item.id === event.currentTarget.value);
    if (!saved) return;
    channelId.value = saved.channelId;
    card.querySelector(".channel-name").textContent = saved.name;
    refreshChannelPickers();
  });
  card.querySelector(".channel-name").textContent = channel.channelTitle || channel.id || "YouTube channel";
  card.querySelector(".remove-channel").addEventListener("click", () => {
    const channelName = card.querySelector(".channel-name").textContent.trim() || "this notification route";
    if (!window.confirm(`Remove the route for ${channelName}? Saving routes will stop monitoring this channel.`)) return;
    card.remove();
    refreshChannelPickers();
    updateSetupOverview();
  });
  channelList.append(card);
  refreshRouteDestinations(card, channel.destinations || []);
  refreshChannelPickers();
  updateSetupOverview();
}

function renderChannels(channels) {
  channelList.replaceChildren();
  channels.forEach(addChannel);
}

function collectChannels() {
  return [...channelList.querySelectorAll(".channel-card")].map((card) => ({
    id: card.querySelector(".channel-id").value.trim(),
    destinations: selectedRouteDestinations(card),
  }));
}

async function initialize() {
  try {
    const state = await api("/api/session");
    document.querySelector("#telegram-notice").classList.toggle("hidden", state.telegramConfigured);
    showDashboard(state.authenticated);
    if (state.authenticated) {
      renderSavedDestinations(state.savedDestinations || []);
      renderSavedChannels(state.savedChannels || []);
      renderChannels(state.channels || []);
      renderPollInterval(state.pollIntervalMinutes || 2);
      renderMessageTemplate(state.messageTemplate);
      updateHealth(state.channels || [], state.telegramConfigured);
    }
  } catch (error) {
    showFeedback(error.message, true);
  }
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: document.querySelector("#password").value }),
    });
    document.querySelector("#password").value = "";
    await initialize();
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    button.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showDashboard(false);
});

document.querySelector("#add-channel").addEventListener("click", () => addChannel());
document.querySelector("#add-saved-destination").addEventListener("click", () => addSavedDestination());
document.querySelector("#add-saved-channel").addEventListener("click", () => addSavedChannel());

for (const link of document.querySelectorAll(".workflow-nav a, .overview-card")) {
  link.addEventListener("click", () => {
    const target = document.querySelector(link.getAttribute("href"));
    if (target instanceof HTMLDetailsElement) target.open = true;
    document.querySelectorAll(".workflow-nav a").forEach((item) =>
      item.classList.toggle("is-active", item.getAttribute("href") === link.getAttribute("href")));
  });
}

if ("IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
    if (!visible) return;
    document.querySelectorAll(".workflow-nav a").forEach((link) =>
      link.classList.toggle("is-active", link.getAttribute("href") === `#${visible.target.id}`));
  }, { rootMargin: "-18% 0px -65% 0px", threshold: [0, 0.15, 0.4] });
  for (const section of document.querySelectorAll("#saved-channels, #saved-destinations, #routes")) {
    sectionObserver.observe(section);
  }
}

document.querySelector("#save-settings").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        pollIntervalMinutes: Number(document.querySelector("#poll-interval").value),
        messageTemplate: document.querySelector("#message-template").value,
      }),
    });
    renderPollInterval(result.pollIntervalMinutes);
    renderMessageTemplate(result.messageTemplate);
    showFeedback(`Check interval and Telegram template saved. Checks run every ${result.pollIntervalMinutes} minute${result.pollIntervalMinutes === 1 ? "" : "s"}.`);
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#save-template").addEventListener("click", async () => {
  document.querySelector("#save-settings").click();
});

document.querySelector("#reset-template").addEventListener("click", () => {
  renderMessageTemplate(DEFAULT_MESSAGE_TEMPLATE);
});

document.querySelector("#save-channels").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api("/api/saved-channels", {
      method: "PUT",
      body: JSON.stringify({ channels: collectSavedChannels() }),
    });
    renderSavedChannels(result.channels);
    showFeedback("Saved YouTube channels updated.");
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#save-destinations").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api("/api/saved-destinations", {
      method: "PUT",
      body: JSON.stringify({ destinations: collectSavedDestinations() }),
    });
    renderSavedDestinations(result.destinations);
    showFeedback("Saved Telegram destinations updated.");
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#save-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const channels = collectChannels();
    const channelIds = new Set();
    for (const channel of channels) {
      if (!channel.id) continue;
      if (channelIds.has(channel.id)) {
        throw new Error("Each YouTube channel can have only one notification route. Add destinations to its existing route.");
      }
      channelIds.add(channel.id);
    }
    if (channels.some((channel) => channel.destinations.length === 0)) {
      throw new Error("Select at least one Telegram group or topic for every notification route.");
    }
    const result = await api("/api/channels", {
      method: "PUT",
      body: JSON.stringify({ channels }),
    });
    renderChannels(result.channels);
    const state = await api("/api/session");
    updateHealth(result.channels, state.telegramConfigured);
    showFeedback("Your notification routes have been saved.");
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#check-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.querySelector(".refresh-icon").classList.add("spinning");
  setMonitorStatus("Checking feeds…", "Fetching the latest YouTube uploads.", "warning");
  try {
    const result = await api("/api/check", { method: "POST" });
    renderChannels(result.channels);
    const state = await api("/api/session");
    updateHealth(result.channels, state.telegramConfigured);
    if (result.channels.some((channel) => channel.lastError)) {
      showFeedback("Check completed, but a channel or delivery reported an error. See monitor status.", true);
    } else {
      showFeedback("YouTube channel feeds checked.");
    }
  } catch (error) {
    setMonitorStatus("Check failed", error.message, "error");
    showFeedback(error.message, true);
  } finally {
    button.disabled = false;
    button.querySelector(".refresh-icon").classList.remove("spinning");
  }
});

initialize();
window.setInterval(async () => {
  if (dashboardView.classList.contains("hidden")) return;
  try {
    const state = await api("/api/session");
    if (state.authenticated) {
      renderPollInterval(state.pollIntervalMinutes || 2);
      updateHealth(state.channels || [], state.telegramConfigured);
    }
  } catch {
    setMonitorStatus("Status unavailable", "Could not refresh monitor health. Check that the app server is running.", "error");
  }
}, 30_000);
