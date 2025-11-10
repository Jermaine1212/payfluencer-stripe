// server.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const dotenvPath = path.resolve(__dirname, '.env');
console.log('Loaded .env from:', dotenvPath);
const STRIPE_CANDIDATE_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_SECRET',
  'STRIPE_API_KEY',
  'STRIPE_LIVE_SECRET_KEY',
  'STRIPE_TEST_SECRET_KEY'
];
const STRIPE_KEY = STRIPE_CANDIDATE_KEYS.map(k => process.env[k]).find(Boolean);
if (!STRIPE_KEY) {
  console.error('Stripe secret key not found in .env. Checked:', STRIPE_CANDIDATE_KEYS.join(', '));
  console.error('Present STRIPE_* vars:', Object.keys(process.env).filter(k => k.startsWith('STRIPE')));
  process.exit(1);
}
console.log('Stripe key loaded, starts with:', String(STRIPE_KEY).slice(0, 8));
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('📡 MongoDB connected'))
  .catch(err => {
    console.error('Mongo connection error:', err);
    process.exit(1);
  });

// Define a User model for wallet balances (stored in pence)
const userSchema = new mongoose.Schema({
  _id: String,
  walletBalance: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// Transaction schema to keep a history of wallet activity
const txSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  type:   { type: String, enum: ['topup', 'refund', 'campaign_hold', 'campaign_paid', 'campaign_payout', 'commission', 'withdraw'], required: true },
  amount: { type: Number, required: true }, // pence, positive for top up, negative for refund
  status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending' },
  stripeId: String,                         // session ID or charge ID
  description: { type: String },
  createdAt: { type: Date, default: Date.now }
});
// Avoid duplicate credits if Stripe retries the same event
txSchema.index({ stripeId: 1 }, { unique: true, partialFilterExpression: { stripeId: { $exists: true } } });
const Transaction = mongoose.model('Transaction', txSchema);

console.log('Starting server.js...');
console.log('>>> PAYFLUENCER STRIPE – dynamic-amount version loaded at', new Date().toISOString());
console.log('>>> Source file:', __filename);
console.log('-------------------------------------------------------------');

// Check required environment variables
if (!process.env.DOMAIN) {
  console.error('Missing DOMAIN in .env');
  process.exit(1);
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error('Missing STRIPE_WEBHOOK_SECRET in .env');
  process.exit(1);
}
if (!process.env.AUTH_JWT_SECRET) {
  console.error('Missing AUTH_JWT_SECRET in .env');
  process.exit(1);
}
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

const app = express();

// ===== Auth helpers =====
function parseAuth(req) {
  const header = req.headers['authorization'] || '';
  const [, token] = header.split(' ');
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.AUTH_JWT_SECRET); // HS256 by default
    return { userId: payload.sub || payload.userId, role: payload.role || 'user', payload };
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const auth = parseAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  req.auth = auth;
  next();
}

function requireUserMatch(paramPath) {
  // paramPath like 'body.userId' or 'query.userId'
  return (req, res, next) => {
    const auth = req.auth || parseAuth(req);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const parts = paramPath.split('.');
    let cursor = req;
    for (const p of parts) cursor = cursor?.[p];
    const targetId = cursor;
    if (!targetId || targetId !== auth.userId) {
      return res.status(403).json({ error: 'Forbidden: user mismatch' });
    }
    next();
  };
}

function isAdmin(req) {
  const auth = req.auth || parseAuth(req);
  const headerKey = req.headers['x-admin-api-key'];
  if ((auth && auth.role === 'admin') || (ADMIN_API_KEY && headerKey && headerKey === ADMIN_API_KEY)) {
    return true;
  }
  return false;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  next();
}

// Simple numeric validator for pound inputs
function toPence(amountPounds) {
  const n = Number(amountPounds);
  if (!Number.isFinite(n)) return null;
  const pennies = Math.round(n * 100);
  if (pennies < 0) return null;
  return pennies;
}

// Enable CORS for browser calls with credentials from allowed origins
const ALLOWED_ORIGINS = [
  process.env.DOMAIN,
  'https://payfluencer.app',
  'https://www.payfluencer.app'
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser or same-origin requests with no Origin header
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-api-key']
};

app.use(cors(corsOptions));
// Generic preflight responder for all routes (avoids path-to-regexp issues on Express 5)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Simple health check for Render
app.get('/healthz', (_req, res) => res.sendStatus(200));

// Initialise Stripe with your secret key from .env
const stripe = Stripe(STRIPE_KEY);

// 2️⃣  STRIPE WEBHOOK ENDPOINT  (must come before express.json())
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.sendStatus(400);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session?.metadata?.userId;
      const amount = session.amount_total; // pence
      if (!userId || !amount) {
        console.warn('checkout.session.completed missing userId or amount', { userId, amount });
      } else {
        const exists = await Transaction.findOne({ stripeId: session.id });
        if (exists) {
          console.log('Duplicate webhook received. Skipping credit for session', session.id);
        } else {
          console.log(`Top up successful for user ${userId}; amount: £${(amount / 100).toFixed(2)}`);
          await User.findByIdAndUpdate(
            userId,
            { $inc: { walletBalance: amount } },
            { upsert: true }
          );
          await Transaction.create({
            userId,
            type: 'topup',
            amount,
            stripeId: session.id,
            status: 'completed'
          });
        }
      }
    }
    // Handle partial or full refunds (or charge disputes that lead to a refund)
    else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const charge = event.data.object;   // charge or dispute object
      const metadata = charge.metadata || (charge.charge && charge.charge.metadata) || {};
      const userId = metadata.userId;
      const amount = charge.amount || (charge.charge && charge.charge.amount) || 0; // pence
      const stripeId = charge.id || (charge.charge && charge.charge.id);

      if (userId && amount > 0 && stripeId) {
        const exists = await Transaction.findOne({ stripeId });
        if (exists) {
          console.log('Duplicate refund/dispute webhook. Skipping for', stripeId);
        } else {
          await User.findByIdAndUpdate(
            userId,
            { $inc: { walletBalance: -amount } },
            { upsert: true }
          );
          await Transaction.create({
            userId,
            type: 'refund',
            amount: -amount,
            stripeId,
            status: 'completed'
          });
          console.log(`Refund processed for user ${userId}; amount: -£${(amount / 100).toFixed(2)}`);
        }
      } else {
        console.warn('Refund/dispute webhook missing userId, amount, or stripeId');
      }
    }
    res.sendStatus(200);
  }
);

app.use(express.json());   // safe because /webhook is declared above

// Log every request for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Add a root route to verify server is running
app.get('/', (req, res) => {
  res.send('Server is running!');
});

/**
 * 1️⃣  CREATE CHECKOUT SESSION
 * Expects JSON body: { "amountPounds": "...", "userId": "..." }  // or legacy { "priceId": "...", "userId": "..." }
 * Returns: { url: "https://checkout.stripe.com/..." }
 */
app.post('/create-checkout-session', async (req, res) => {
  // Dynamically pick the redirect origin from the incoming request (fall back to .env)
  const origin = req.get('Origin') || process.env.DOMAIN;
  try {
    const { amountPounds, priceId } = req.body;
    const userId = req.body.userId || req.body.userid || req.query.userId || req.query.userid;
    if (!userId) { return res.status(400).json({ error: 'Missing userId' }); }
    console.log('Body received:', req.body);

    // Allow either a dynamic amount *or* a fixed priceId for backward compatibility
    let line_items;
    if (priceId) {
      // Fixed‑price flow (legacy)
      line_items = [{ price: priceId, quantity: 1 }];
    } else {
      // Dynamic‑amount flow
      const amount = toPence(amountPounds);
      if (!amount || amount < 2000) {
        return res.status(400).json({ error: 'Minimum top‑up is £20' });
      }
      line_items = [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: amount,
            product_data: { name: 'Wallet Top‑Up' }
          },
          quantity: 1
        }
      ];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/cancel`,
      metadata: { userId }
    });

    res.json({ url: session.url });
  } catch (err) {
    // log the low-level network details from stripe-node
    console.error('Stripe network failure →', {
      message: err.message,
      code: err.code,
      errno: err.errno,
      stack: err.stack
    });
    res.status(500).json({ error: err.message });
  }
});

// Reconcile a checkout session by ID, used by the Success page to ensure credit even if webhook was delayed
app.get('/checkout/session-status', async (req, res) => {
  let sessionId = req.query.session_id || req.query.sessionId || null;
  const paymentIntentId = req.query.payment_intent || req.query.paymentIntent || req.query.pi || null;

  try {
    // If only a payment_intent was provided, find the related Checkout Session
    if (!sessionId && paymentIntentId) {
      const list = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
      if (list && list.data && list.data.length) {
        sessionId = list.data[0].id;
      }
    }

    if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session?.payment_status === 'paid' || session?.status === 'complete';
    const userId = session?.metadata?.userId;
    const amount = session?.amount_total;

    let processed = false;
    if (paid && userId && amount) {
      const exists = await Transaction.findOne({ stripeId: session.id });
      if (!exists) {
        await User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } }, { upsert: true });
        await Transaction.create({ userId, type: 'topup', amount, stripeId: session.id, status: 'completed' });
        processed = true;
      }
    }

    const user = userId ? await User.findById(userId) : null;
    res.json({ paid, processed, balance: user?.walletBalance ?? null, sessionId });
  } catch (e) {
    console.error('session-status error', e);
    res.status(500).json({ error: 'session-status failed' });
  }
});

// Endpoint to fetch a user's wallet balance (in pence)
app.get('/wallet/balance', async (req, res) => {
  const userId = req.query.userId || req.query.userid;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    console.log('GET /wallet/balance', { userId });

    // Auto-create a wallet row if it doesn't exist yet so new accounts don't 404
    const user = await User.findByIdAndUpdate(
      userId,
      { $setOnInsert: { walletBalance: 0 } },
      { upsert: true, new: true }
    );

    return res.json({ balance: user.walletBalance || 0 });
  } catch (err) {
    console.error('Error fetching balance:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to fetch a user's transaction history (most recent first)
app.get('/wallet/transactions', async (req, res) => {
  const userId = req.query.userId || req.query.userid;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    const txs = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(100);
    res.json({ transactions: txs });
  } catch (err) {
    console.error('Error fetching transactions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Quick debug endpoint to inspect a user's wallet and recent transactions
app.get('/wallet/debug', async (req, res) => {
  const userId = req.query.userId || req.query.userid;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    const user = await User.findById(userId);
    const txs = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(10);
    res.json({
      userId,
      balance: user?.walletBalance ?? 0,
      txCount: txs.length,
      recent: txs
    });
  } catch (e) {
    console.error('wallet/debug error', e);
    res.status(500).json({ error: 'debug failed' });
  }
});

/**
 * 3️⃣  WITHDRAWAL ENDPOINTS (manual PayPal payouts)
 */

// POST /wallet/withdraw-request
// Body: { userId, amountPounds, paypalEmail }
app.post('/wallet/withdraw-request', requireAuth, requireUserMatch('body.userId'), async (req, res) => {
  try {
    const { userId, amountPounds, paypalEmail } = req.body;
    if (!userId || !amountPounds || !paypalEmail) {
      return res.status(400).json({ error: 'Missing params' });
    }
    const amount = toPence(amountPounds);
    if (!amount) return res.status(400).json({ error: 'Invalid amount' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.walletBalance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const tx = await Transaction.create({
      userId,
      type: 'withdraw',
      amount: -amount,
      stripeId: paypalEmail, // store email for reference
      status: 'pending'
    });

    res.json({ status: 'pending', txId: tx._id });
  } catch (err) {
    console.error('Error creating withdraw request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /wallet/withdraw-complete
// Body: { txId }  -- Should be called by admin AFTER sending PayPal payout
app.patch('/wallet/withdraw-complete', requireAdmin, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ error: 'Missing txId' });

    const tx = await Transaction.findById(txId);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal already completed' });
    }

    // Deduct funds now (tx.amount is negative)
    await User.findByIdAndUpdate(tx.userId, { $inc: { walletBalance: tx.amount } });

    tx.status = 'completed';
    await tx.save();

    res.json({ status: 'completed' });
  } catch (err) {
    console.error('Error completing withdrawal:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /wallet/deduct-campaign-budget
// Body: { userId, campaignId, campaignName, amountPounds }
app.post('/wallet/deduct-campaign-budget', requireAuth, requireUserMatch('body.userId'), async (req, res) => {
  try {
    const { userId, campaignId, campaignName, amountPounds } = req.body;
    if (!userId || !campaignId || !amountPounds) {
      return res.status(400).json({ error: 'Missing params' });
    }

    const amount = toPence(amountPounds);
    if (!amount) return res.status(400).json({ error: 'Invalid amount' });
    const user   = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.walletBalance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Hold the funds
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });

    // Record the hold in transaction history
    await Transaction.create({
      userId,
      type: 'campaign_hold',
      amount: -amount,
      stripeId: campaignId,      // store campaignId for reconciliation
      description: campaignName,
      status: 'pending'
    });

    res.json({ status: 'held', balanceAfter: user.walletBalance - amount });
  } catch (err) {
    console.error('Deduct campaign budget error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/*  🔙  Refund a cancelled invite / campaign                           */
/* ------------------------------------------------------------------ */
// POST /wallet/refund-campaign-budget
// Body: { userId, campaignId, amountPounds }
app.post('/wallet/refund-campaign-budget', requireAdmin, async (req, res) => {
  try {
    const { userId, campaignId, amountPounds } = req.body;
    if (!userId || !campaignId || !amountPounds) {
      return res.status(400).json({ error: 'Missing params' });
    }
    const amount = toPence(amountPounds);
    if (!amount) return res.status(400).json({ error: 'Invalid amount' });

    // 1) credit the user’s wallet
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });

    // 2) mark the hold as cancelled & record refund
    await Transaction.updateMany(
      { userId, stripeId: campaignId, type: 'campaign_hold', status: 'pending' },
      { status: 'cancelled' }
    );
    await Transaction.create({
      userId,
      type: 'refund',
      amount,
      stripeId: campaignId,
      description: 'Campaign cancelled – funds returned',
      status: 'completed'
    });

    console.log(`💸 REFUND  £${(amount / 100).toFixed(2)} → user ${userId}  (campaign ${campaignId})`);
    res.json({ status: 'refunded', balanceDelta: amount });
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* ------------------------------------------------------------------ */
/*  ✅  Final‑pay when brand approves submission                       */
/* ------------------------------------------------------------------ */
// PATCH /wallet/campaign-payment-complete
// Body: { userId, influencerId, campaignId }
app.patch('/wallet/campaign-payment-complete', requireAdmin, async (req, res) => {
  try {
    const { userId, influencerId, campaignId } = req.body;
    if (!userId || !influencerId || !campaignId) {
      return res.status(400).json({ error: 'Missing params' });
    }

    // 1) flip pending hold → completed (keep record for brand)
    const holdTx = await Transaction.findOneAndUpdate(
      { userId, stripeId: campaignId, type: 'campaign_hold', status: 'pending' },
      { status: 'completed', type: 'campaign_paid' },
      { new: true }
    );
    if (!holdTx) {
      return res.status(404).json({ error: 'Pending hold not found' });
    }

    const gross       = Math.abs(holdTx.amount);            // pence
    const commission  = Math.round(gross * 0.10);           // 10%
    const netPayout   = gross - commission;                 // 90%

    /* 2) credit influencer wallet with net amount */
    await User.findByIdAndUpdate(influencerId, { $inc: { walletBalance: netPayout } }, { upsert: true });

    /* 3) create two ledger rows: influencer payout & platform commission */
    await Transaction.create([
      {
        userId: influencerId,
        type: 'campaign_payout',
        amount: netPayout,
        stripeId: campaignId,
        description: 'Net payout after 10% commission',
        status: 'completed'
      },
      {
        userId: 'PLATFORM',
        type: 'commission',
        amount: commission,
        stripeId: campaignId,
        description: `10% commission on campaign ${campaignId}`,
        status: 'completed'
      }
    ]);

    console.log(`✅ PAYMENT COMPLETE  campaign ${campaignId}  gross £${(gross/100).toFixed(2)}  net £${(netPayout/100).toFixed(2)}  commission £${(commission/100).toFixed(2)}`);

    res.json({ status: 'paid', net: netPayout, commission });
  } catch (err) {
    console.error('Payment‑complete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generic error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  const key = STRIPE_KEY || '';
  console.log(`Stripe mode: ${key.startsWith('sk_test') ? 'TEST' : 'LIVE'}`);
  console.log(`Domain: ${process.env.DOMAIN}`);
});
