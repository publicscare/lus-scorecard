# Lu's Scorecard + Scoreboard

One web app, two roles chosen on load:

- **Lu's Scorecard** — the senior-softball scorer (writer / single source of truth).
  Starts a game, shows a short game code, and writes the live score to Supabase.
- **Lu's Scoreboard** — a read-only display. Enter the same code to watch the game
  update live on any device.

## Run locally
```
npm install
npm run dev
```

## Deploy on Vercel
Import this repo in Vercel. It auto-detects **Vite**:
- Build Command: `npm run build`
- Output Directory: `dist`

Deploy, then open the resulting URL on the scorer's device and on each viewer's phone.

## Configuration
Supabase Project URL and **publishable** key are set near the top of
`src/App.jsx` (the `SUPABASE_URL` / `SUPABASE_KEY` constants). The publishable
key is safe to ship in client code. The app expects a `games` table:

```sql
create table if not exists public.games (
  code       text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.games enable row level security;
create policy "public read"   on public.games for select using (true);
create policy "public insert" on public.games for insert with check (true);
create policy "public update" on public.games for update using (true) with check (true);
```
