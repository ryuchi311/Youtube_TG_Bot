# TubeSignal

A small web app that monitors YouTube channels and posts each new upload to one or more Telegram group chats or Discord channels.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The bot must be added to each destination group and allowed to send messages. For topic notifications, use the topic's message ID as its topic ID.
- A YouTube channel ID for each channel to monitor (starts with `UC` and has 24 characters). Find it in YouTube Studio under **Settings → Channel → Advanced settings**.

## Run

Set an admin password and bot token in the environment, then start the app:

```powershell
$env:ADMIN_PASSWORD = "choose-a-long-password"
$env:TELEGRAM_BOT_TOKEN = "your-bot-token"
npm start
```

Open `http://127.0.0.1:3000`. Optionally set `PORT` and `HOST` to choose the listening address. The default host only accepts connections from the same machine.

## Configure notifications

1. Sign in with `ADMIN_PASSWORD`.
2. In the **YouTube channels** setup section, enter a channel ID and click **Fetch details** to verify it and fill in its public name. Then click **Save channels**. Existing monitored channels are automatically added to this list the first time the updated app starts.
3. In **Telegram & Discord**, choose a destination platform. For Telegram, enter a group chat ID (commonly `-100...`) and optionally a positive topic ID. Click **Fetch details**, then **Test**; the bot must be in the group. For Discord, create an incoming webhook for a regular text channel in Discord, paste its webhook URL, and click **Test**. Forum and media channels are not supported. Treat the URL like a password: anyone with it can post to its channel. Click **Save destinations** when ready.
4. In **Connect channels to destinations**, create one route per YouTube channel. Expand **Notification destinations** inside the route, then select every saved group, topic, or Discord channel that should receive its uploads. Destination lists and the routes section are collapsed by default; click their headings or use the setup navigation to open them. A channel can select up to 30 destinations.
5. Click **Save routes**. Use the setup overview cards or sticky step navigation to jump between sections. The dashboard shows monitor health and each destination's latest test status.

The app checks YouTube's public RSS feeds as soon as it starts and then at the selected interval (1, 2, 5, 10, 15, 30, or 60 minutes; default 2). Open **Monitoring settings** to change the interval or customize the Telegram message. Discord receives a video embed with the title, channel, publication time, link, and thumbnail. Changes are persisted and the new interval is applied immediately. It displays each channel's latest public upload in the route card. On the first check, the latest upload is sent to each configured destination; newly added destinations also receive the current latest upload once. Subsequent uploads are delivered to every configured destination for that channel. Use **Check now** to run a check immediately.

Customize Telegram captions under **Telegram upload message template**. The default template includes the YouTube thumbnail, upload title, channel, publication time, and video link. Templates support Telegram HTML plus `{title}`, `{channel}`, `{published}`, `{url}`, and `{videoId}` placeholders; static text can include channel hashtags or group invitation links. Save the template before the next upload.

Configuration, upload cursors, and saved Discord webhook URLs are stored in `data/config.json` for the local app, or in D1 for Cloudflare. The bot token and admin password are not written to disk. Protect backups and restrict dashboard access because webhook URLs grant posting access to their Discord channels. Keep the app bound to localhost unless you put it behind HTTPS and restrict access to the dashboard.

Removal buttons ask for confirmation before removing a saved channel, Telegram destination, or notification route from the editor.

## Deploy to Cloudflare

The project includes a Cloudflare Workers version of the app. It serves the existing dashboard, stores settings, revocable admin sessions, and upload cursors in D1, and uses a one-minute Cron Trigger to honor the selected check interval. The original Node.js app and `data/config.json` continue to work locally.

### One-click Windows deploy

1. Install [Node.js 20 or newer](https://nodejs.org/) and sign in to a [Cloudflare account](https://dash.cloudflare.com/).
2. Double-click **`deploy-to-cloudflare.cmd`** in the project folder. It installs project dependencies if needed, opens Cloudflare login if Wrangler is not already authenticated, creates the D1 database, applies its schema, and deploys the Worker.
3. If `data/config.json` exists, the script asks whether to import it. Type `IMPORT` only if you want to copy the current local channels, destinations, settings, and upload cursors to Cloudflare.
4. On the first deployment, Wrangler prompts for `ADMIN_PASSWORD` and `TELEGRAM_BOT_TOKEN`. Enter them only in Wrangler's secret prompts; they are not saved in this project. The script skips secrets that are already configured.
5. Open the `workers.dev` URL Wrangler prints and sign in with the admin password.

Alternatively, run `npm install` followed by `npm run cloudflare:deploy` in a terminal. To test locally with Workers, copy `.dev.vars.example` to `.dev.vars`, replace its example values, then run `npm run cloudflare:dev`. That command applies pending migrations to local D1 before starting Wrangler. Local Worker data is kept in Wrangler's local D1 state and is separate from `data/config.json`.

To explicitly replace the deployed configuration with the current local `data/config.json` later, run `npm run cloudflare:import` and type `IMPORT` when prompted. This overwrites the current Cloudflare channels, routes, settings, and upload cursors. Keep a backup before importing.
