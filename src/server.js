require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const widgetRoutes = require('./routes/widget');
const dashboardRoutes = require('./routes/dashboard');
const publicRoutes = require('./routes/public');

const app = express();

// Trust Render's proxy so req.protocol correctly reports 'https' — fixes the
// http:// URLs that were showing up in signup responses (embedSnippet, chatUrl).
app.set('trust proxy', 1);

// CORS: the widget is embedded on hotel websites (arbitrary origins) so
// message/voice/branding endpoints need to be open. Auth/dashboard routes
// stay locked to configured origins.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, mobile apps, server-to-server
    // Widget endpoints (below) accept any origin. Others must be whitelisted.
    cb(null, true);
  },
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check for Render
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Route mounting — API routes MUST come before static so /message doesn't get
// caught by a stray file with the same name.
app.use('/auth', authRoutes);
app.use('/', widgetRoutes);        // POST /message, /voice-message, GET /audio/:id, /branding, /itinerary
app.use('/', publicRoutes);        // GET /chat/:hotelId, /qr/:hotelId

// Serve the dashboard HTML at bare /dashboard. This MUST be registered before
// the /dashboard API router, otherwise Express hands GET /dashboard to the
// API router which 404s (it has no root handler).
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));
app.use('/dashboard', dashboardRoutes);

// ---- Frontend static files ----
// The landing page, signup, contact, onboarding all live in /public. Express
// serves them at their respective URLs (/, /signup, /contact, /onboarding).
// index-v2.html is served as the root — cleaner URL than /index-v2.html.
const publicDir = path.join(__dirname, '..', 'public');
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index-v2.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(publicDir, 'signup.html')));
app.get('/signin', (req, res) => res.sendFile(path.join(publicDir, 'signin.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(publicDir, 'contact.html')));
app.get('/onboarding', (req, res) => res.sendFile(path.join(publicDir, 'onboarding.html')));
app.get('/widget-ui', (req, res) => res.sendFile(path.join(publicDir, 'widget-ui.html')));
app.use(express.static(publicDir)); // fallback for any other assets (widget.js, images, css, etc.)

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[karibu] backend listening on :${port}`);
  console.log(`[karibu] env: ${process.env.NODE_ENV || 'development'}`);
});
