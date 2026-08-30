# Ezicon Backend

Monolithic Node/Express backend for the Ezicon AI concierge. Handles guest
messaging (text + voice), tiered response routing, staff dashboard endpoints,
per-hotel branding and QR codes, and plan enforcement.

## Stack

- Node.js 20+ / Express 4
- PostgreSQL (managed by Render in production)
- Groq API for LLM (Llama 3.3 70B) + Whisper STT
- ElevenLabs API for premium TTS voice replies

## Local development

```bash
cp .env.example .env
# Fill in DATABASE_URL, GROQ_API_KEY, ELEVENLABS_API_KEY

npm install
npm run migrate
npm run dev
```

The server listens on `PORT` (default 3000). Test with:

```bash
curl http://localhost:3000/health
```

## Deploy to Render

The `render.yaml` at the repo root is a Render blueprint. To deploy:

1. Push this repo to GitHub
2. On Render → New → Blueprint → select your repo
3. Render creates the web service + managed Postgres automatically
4. Add secrets in Render dashboard: `GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `ALLOWED_ORIGINS`
5. First deploy runs `npm run migrate` before starting

## Key endpoints

### Widget-facing (public, no auth)

- `POST /message` — guest sends text; returns tiered reply
- `POST /voice-message` — guest sends audio blob; transcribed + tiered; premium adds TTS reply
- `GET /audio/:id` — cached TTS output
- `GET /branding?hotelId=...` — hotel's logo, colors, tagline
- `POST /itinerary` — interests → day plan (partner operators first)
- `GET /chat/:hotelId` — branded standalone chat page (QR / bio-link destination)
- `GET /qr/:hotelId` — PNG QR code pointing at the standalone page

### Auth

- `POST /auth/signup` — creates account + first hotel, returns JWT + embed snippet + chat URL
- `POST /auth/signin` — returns JWT

### Dashboard (requires JWT)

- `GET  /dashboard/hotels` — list this account's properties
- `PATCH /dashboard/hotels/:hotelId` — update branding, plan, voice toggle, languages
- `GET  /dashboard/hotels/:hotelId/knowledge` — list KB entries
- `POST /dashboard/hotels/:hotelId/knowledge` — add KB entry
- `DELETE /dashboard/knowledge/:entryId`
- `GET  /dashboard/hotels/:hotelId/operators` — list local operators
- `POST /dashboard/hotels/:hotelId/operators` — add operator
- `DELETE /dashboard/operators/:operatorId`
- `GET  /dashboard/hotels/:hotelId/queue` — the message queue with today's counts
- `POST /dashboard/messages/:messageId/approve` — approve or edit a drafted reply
- `POST /dashboard/messages/:messageId/dismiss`

## Architecture notes

**One resolver, all channels.** `src/services/resolver.js` is the single decision
engine. Text and voice both funnel through it, which means the tier logic
(escalation → KB → LLM) is defined once and consistent regardless of how the
guest reached us.

**Plan limits enforced before spend.** Every paid AI call is gated by
`checkLimit()`; free-tier users can never accidentally cost you money past
their monthly cap.

**Cheap-path first.** Escalation regex → KB keyword lookup → LLM. The first
two are free; only genuinely novel questions hit the LLM.

**Stateless audio via in-memory cache.** TTS output cached for 1hr in-process.
For production scale, swap `services/audioCache.js` for S3/R2 uploads.

## What's not built yet

Intentionally out of scope for MVP:

- Billing / subscription management (Stripe integration)
- WhatsApp Business API channel adapter (structure is there — `channel` field
  on conversations exists — but no webhook route yet)
- Real-time push to staff dashboard (currently a poll from the UI)
- Onboarding wizard state machine
- PMS integrations (Hotelogix, HotelOnline, eZee, etc.)
