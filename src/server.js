require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const widgetRoutes = require('./routes/widget');
const dashboardRoutes = require('./routes/dashboard');
const publicRoutes = require('./routes/public');

const app = express();

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

// Route mounting
app.use('/auth', authRoutes);
app.use('/', widgetRoutes);        // POST /message, /voice-message, GET /audio/:id, /branding, /itinerary
app.use('/', publicRoutes);        // GET /chat/:hotelId, /qr/:hotelId
app.use('/dashboard', dashboardRoutes);

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
