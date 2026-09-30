# ygbh-server

WebSocket game server for **Yard Goats vs the Ball Hogs** (backyard football, 2–4 players).

## Deploy on Fly.io from the dashboard (no CLI, works with SSO accounts)

1. Open https://fly.io/dashboard → **Create** → **Launch an App**
2. Choose **Deploy from GitHub** (connect GitHub if asked, pick repo `ejarr1998/ygbh-server`)
3. Fly auto-detects the `Dockerfile` — no build settings needed
4. Region: choose closest to your family (e.g. `iad`)
5. **Do not add a Postgres or Redis** — the server is in-memory only
6. Finish launch → Fly builds and deploys (~2 min)

The server will be live at `wss://ygbh-server.fly.dev` (WebSocket, ports 80/443).

## Free tier notes
- 256MB shared-cpu machine — within Fly's free allowance
- `auto_stop_machines = 'off'` in fly.toml keeps it always on
- In-memory rooms: restarting the machine clears active lobbies (acceptable for v1)

## Local dev
```bash
npm install
node index.mjs   # listens on :8787
```
