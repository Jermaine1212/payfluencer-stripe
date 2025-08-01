// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const mongoose = require('mongoose');
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
  amount: { type: Number, required: true }, // pence, positive for top‑up, negative for refund
  status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
  stripeId: String,                         // session ID or charge ID
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', txSchema);

console.log('Starting server.js...');
console.log('>>> PAYFLUENCER STRIPE – dynamic-amount version loaded at', new Date().toISOString());
console.log('>>> Source file:', __filename);
console.log('-------------------------------------------------------------');

// Check required environment variables
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY in .env');
  process.exit(1);
}
if (!process.env.DOMAIN) {
  console.error('Missing DOMAIN in .env');
  process.exit(1);
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error('Missing STRIPE_WEBHOOK_SECRET in .env');
  process.exit(1);
}

const app = express();

// Enable CORS for all routes
app.use(cors());
// Explicit preflight handler for the checkout session endpoint
app.options('/create-checkout-session', cors());

// Simple health check for Render
app.get('/healthz', (_req, res) => res.sendStatus(200));

// Initialise Stripe with your secret key from .env
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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
      console.log(
        `Top‑up successful for user ${session.metadata.userId}; amount: £${(
          session.amount_total / 100
        ).toFixed(2)}`
      );
      // Update user balance in the database
      const userId = session.metadata.userId;
      const amount = session.amount_total;  // in pence
      await User.findByIdAndUpdate(
        userId,
        { $inc: { walletBalance: amount } },
        { upsert: true }
      );
      // Record transaction history
      await Transaction.create({
        userId,
        type: 'topup',
        amount,
        stripeId: session.id
      });
    }
    // Handle partial or full refunds (or charge disputes that lead to a refund)
    else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const charge = event.data.object;   // charge or dispute object
      // If this is a dispute, pull the underlying charge for amount/metadata consistency
      const metadata = charge.metadata || (charge.charge && charge.charge.metadata) || {};
      const userId = metadata.userId;
      const amount = charge.amount || (charge.charge && charge.charge.amount) || 0; // pence

      if (userId && amount > 0) {
        await User.findByIdAndUpdate(
          userId,
          { $inc: { walletBalance: -amount } },
          { upsert: true }
        );
        // Record refund in transaction history
        await Transaction.create({
          userId,
          type: 'refund',
          amount: -amount,
          stripeId: charge.id || (charge.charge && charge.charge.id)
        });
        console.log(
          `Refund processed for user ${userId}; amount: -£${(amount / 100).toFixed(2)}`
        );
      } else {
        console.warn('Refund/dispute webhook missing userId or amount');
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
    const { amountPounds, priceId, userId } = req.body;
    console.log('Body received:', req.body);

    // Allow either a dynamic amount *or* a fixed priceId for backward compatibility
    let line_items;
    if (priceId) {
      // Fixed‑price flow (legacy)
      line_items = [{ price: priceId, quantity: 1 }];
    } else {
      // Dynamic‑amount flow
      const amount = Math.round(parseFloat(amountPounds) * 100); // pounds → pence
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

// Endpoint to fetch a user's wallet balance (in pence)
app.get('/wallet/balance', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ balance: user.walletBalance });
  } catch (err) {
    console.error('Error fetching balance:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to fetch a user's transaction history (most recent first)
app.get('/wallet/transactions', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    const txs = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(100);
    res.json({ transactions: txs });
  } catch (err) {
    console.error('Error fetching transactions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 3️⃣  WITHDRAWAL ENDPOINTS (manual PayPal payouts)
 */

// POST /wallet/withdraw-request
// Body: { userId, amountPounds, paypalEmail }
app.post('/wallet/withdraw-request', async (req, res) => {
  try {
    const { userId, amountPounds, paypalEmail } = req.body;
    if (!userId || !amountPounds || !paypalEmail) {
      return res.status(400).json({ error: 'Missing params' });
    }
    const amount = Math.round(parseFloat(amountPounds) * 100); // pence
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
app.patch('/wallet/withdraw-complete', async (req, res) => {
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
app.post('/wallet/deduct-campaign-budget', async (req, res) => {
  try {
    const { userId, campaignId, campaignName, amountPounds } = req.body;
    if (!userId || !campaignId || !amountPounds) {
      return res.status(400).json({ error: 'Missing params' });
    }

    const amount = Math.round(parseFloat(amountPounds) * 100); // pounds → pence
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
app.post('/wallet/refund-campaign-budget', async (req, res) => {
  try {
    const { userId, campaignId, amountPounds } = req.body;
    if (!userId || !campaignId || !amountPounds) {
      return res.status(400).json({ error: 'Missing params' });
    }
    const amount = Math.round(parseFloat(amountPounds) * 100); // pounds → pence

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
app.patch('/wallet/campaign-payment-complete', async (req, res) => {
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

// Start server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  const key = process.env.STRIPE_SECRET_KEY || '';
  console.log(`Stripe mode: ${key.startsWith('sk_test') ? 'TEST' : 'LIVE'}`);
  console.log(`Domain: ${process.env.DOMAIN}`);
});
