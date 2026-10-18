# 🌧️ Rainwood Village — local server edition

A shared 3D village for you and your friends, running on **your own PC**. No logins,
no accounts, no internet needed — just your wifi.

## Run it

1. Install [Node.js](https://nodejs.org) (any recent version).
2. Open a terminal in this folder and run:

   ```
   node server.js
   ```

3. It prints the addresses to open, e.g.:

   ```
   →  http://localhost:8111
   →  http://192.168.1.42:8111   (share this on your wifi)
   ```

4. Everyone on the same wifi opens the second address in a browser
   (phones included), types a name, picks girl/boy, passes the little
   human check, and walks into the same village — up to ~15 people.
   27 villager bots live there too (5 of them drive a bike, car or
   tractor around the village).

## Which files do I need? (deployment)

The whole hosted edition is **two files** — that's it:

```
village-server/
├── server.js          # the server (zero npm dependencies)
└── public/
    └── index.html     # the game itself, hosted build
```

- Copy that folder to any machine with **Node.js 18+** (tested on v20).
  No `npm install` needed — the server uses only Node built-ins.
- `village-db.json` (and its `.bak`) are **created automatically** when
  the server runs. Don't copy them for a fresh village; **do** copy them
  if you want to bring your current village's progress along (crops,
  built houses, weather, felled trees).
- The single-file edition (`rainwood-village.html`) is a **separate
  build** — it is *not* needed here and does not talk to this server.
  It's for playing straight from disk / LAN, pairing with 5-digit codes.

Useful settings:

- `PORT=80 node server.js` — different port (default 8111)
- `DB=/var/data/village.json node server.js` — keep the DB outside the
  app folder (handy on a VPS). Saves are atomic; a `.bak` is kept too.
- The DB file *is* the whole village state — back it up and your world
  is safe; delete it and the village starts fresh.
- `curl http://localhost:8111/healthz` — health check endpoint.

### Running on the open internet

The server binds `0.0.0.0` and is hardened (sanitized inputs, rate
limits, human check), but it's plain HTTP — meant for LAN/friends.
If you put it on a VPS, run it behind a reverse proxy with HTTPS, e.g.
Caddy:

```
village.example.com {
    reverse_proxy localhost:8111
}
```

WebSocket relay works through such proxies out of the box.

## What's inside

- Everyone sees everyone (name clouds above heads), chat with **Enter**
- Weather (sunny / rain / night) is shared — anyone can change it
- Farming, wood chopping, house building, the market, feeding animals,
  berry picking, roses — all synced
- Dating: a **boy** gives a 🌹 rose to a **girl** to ask her out —
  when she accepts they're a couple 💞 (hearts + a jingle)
- Co-op: work near a friend for teamwork bonuses

## Security notes (please read)

This server was written to be **safe to run on your own machine**:

- **Zero dependencies** — no npm packages, nothing to install, no supply chain.
- **No filesystem writes, no shell commands, no eval** — it only reads one
  static HTML file and relays game messages.
- **Input hardening** — names/chat are sanitized (no HTML/script injection),
  all numbers are range-checked, message size and rate are capped.
- **Human check** — every connection must pass a stop-the-arrow timing
  puzzle before it can join, keeping drive-by bots out.
- **Local by nature** — it binds to your LAN address. Don't port-forward it
  to the open internet; if you ever do, put it behind a reverse proxy with
  HTTPS and a real firewall, and keep `PORT` unchanged.

To change the port: `PORT=9000 node server.js` (Windows: `set PORT=9000`).

Find your PC's LAN IP with `ipconfig` (Windows) or `ip config getifaddr en0` (Mac)
or `ip a` (Linux) — the server also prints it for you.
