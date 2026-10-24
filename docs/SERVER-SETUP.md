# Putting PlayBet online (servers.guru or any Ubuntu server)

About 30 minutes, once. You only need the terminal during this setup. Afterwards the server updates itself
whenever new code is saved to GitHub, and backs itself up every night.

## What you need

- A rented server with **Ubuntu 24.04**, **at least 1 GB of memory**, located in **Germany** (or the Netherlands or
  Finland). On servers.guru, any of their small plans will do.
- The email from the provider with the server's **IP address** (four numbers like `203.0.113.10`) and **root password**.
- Your GitHub account (the one this project is in).

## Step 1: Give the server a free name

1. Go to **duckdns.org** and sign in (with Google or GitHub).
2. Type a name in the **sub domain** box, for example `ourbets`, and click **add domain**.
3. In the **current ip** box next to it, type your server's IP address and click **update ip**.

Your site's address is now `ourbets.duckdns.org`. (If you buy a real domain later, see the end of this guide.)

## Step 2: Open the terminal and connect to the server

The terminal is a window where you type commands.

- **Windows:** press the Start button, type `PowerShell`, and open **Windows PowerShell**.
- **Mac:** press `Cmd + Space`, type `Terminal`, and press Enter.

Type this, with your server's IP address instead of the example, and press Enter:

```
ssh root@203.0.113.10
```

- If it asks *"Are you sure you want to continue connecting?"*, type `yes` and press Enter.
- When it asks for the password, paste the root password from the email (right-click pastes in PowerShell,
  `Cmd + V` on a Mac) and press Enter. **Nothing appears while you type or paste the password.** That's normal.

You're in when the line ends with something like `root@server:~#`.

## Step 3: Give the server read access to the code on GitHub

Copy this whole line, paste it into the terminal and press Enter:

```
apt-get update -q && apt-get install -y -q git && { [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -q -f ~/.ssh/id_ed25519; } && ssh-keyscan -q github.com >> ~/.ssh/known_hosts && cat ~/.ssh/id_ed25519.pub
```

The last line it prints starts with `ssh-ed25519`. Select and copy that whole line. Then on GitHub:

1. Open the project **kotsiosp/git-example** and click **Settings** (at the top).
2. In the left menu, click **Deploy keys**, then **Add deploy key**.
3. **Title:** `PlayBet server`. **Key:** paste the line. Leave **Allow write access** unticked.
4. Click **Add key**.

This lets the server download the code, and nothing else.

## Step 4: Install and start the site

Back in the terminal, paste this and press Enter:

```
git clone -b main git@github.com:kotsiosp/git-example.git /opt/playbet && bash /opt/playbet/scripts/setup-server.sh
```

After a few minutes it asks three questions:

- **Site address:** your DuckDNS name, e.g. `ourbets.duckdns.org`
- **Site name:** what players see at the top, e.g. `PlayBet` (just press Enter to keep that)
- **Master password:** at least 8 characters. Nothing appears as you type it. You'll type it twice.

When it says **Done**, wait a minute or two and open `https://ourbets.duckdns.org` in your browser. Log in as
**admin** with your master password.

You can now close the terminal. You won't need it again for normal use.

## After setup

| You want to… | How |
|---|---|
| Add players, give credits | On your site as **admin** → **Players** |
| Change your master password | On your site → **Account** |
| Get a new feature or a fix | Ask Claude. Once it's saved to GitHub, your server installs it within about 5 minutes. |
| Check a dispute | On your site → **Log** |

**Backups** of all accounts, bets and the log are made every night at 03:30 and kept for 14 days, in
`/opt/playbet-backups` on the server.

## If something goes wrong

- **The site doesn't open:** wait two minutes after setup. Check that the IP address on duckdns.org is your
  server's.
- **Anything else:** connect to the server (Step 2), paste this, and send Claude what it prints. It contains no
  passwords.

```
cd /opt/playbet && git log -1 --oneline && docker compose ps && docker compose logs --tail 40 && tail -20 /var/log/playbet-update.log
```

## Using a real domain later

1. Buy the domain (Namecheap, Cloudflare, Porkbun…).
2. In the registrar's DNS settings, add an **A record** for `@` (and one for `www`) pointing to your server's IP.
3. Connect to the server (Step 2) and run, with your domain instead of `example.com`:

```
cd /opt/playbet && sed -i 's/^DOMAIN=.*/DOMAIN="example.com, www.example.com"/' .env && docker compose up -d
```

Accounts, bets and the log stay as they are. Send your players the new address.
