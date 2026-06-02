const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes    = require('./routes/auth');
const userRoutes    = require('./routes/users');
const roomRoutes    = require('./routes/rooms');
const messageRoutes = require('./routes/messages');
const uploadRoutes  = require('./routes/uploads');
const followRoutes  = require('./routes/follows');
const adminRoutes   = require('./routes/admin');
const storiesRoutes = require('./routes/stories');
const pinRoutes     = require('./routes/pins');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'http://localhost:3000',
      'https://spontaneous-sorbet-ff9583.netlify.app',
      process.env.CLIENT_URL,
    ].filter(Boolean);
    if (!origin || allowed.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.use('/api/auth',     authRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/rooms',    roomRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/uploads',  uploadRoutes);
app.use('/api/pins',     pinRoutes);
app.use('/api/follows',  followRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/stories',  storiesRoutes);

app.use((req, res) => res.status(404).json({ error: `Route ${req.path} not found` }));
app.use(errorHandler);

module.exports = app;