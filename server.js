// server.js
require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');

console.log('Starting server.js...');

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

// Simple health check for Render
app.get('/healthz', (_req, res) => res.sendStatus(200));

// Initialise Stripe with your secret key from .env
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 2️⃣  STRIPE WEBHOOK ENDPOINT  (must come before express.json())
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
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
      // 🔥 TODO: update user balance in DB here
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
 * Expects JSON body: { "priceId": "...", "userId": "..." }
 * Returns: { url: "https://checkout.stripe.com/..." }
 */
app.post('/create-checkout-session', async (req, res) => {
  // req is defined here by Express
  try {
    const { amountPounds, userId } = req.body;

    // Convert the UI‑supplied amount (in pounds) to pence
    const amount = Math.round(parseFloat(amountPounds) * 100);

    // Enforce a £20 minimum top‑up (2 000 pence)
    if (!amount || amount < 2000) {
      return res.status(400).json({
        error: 'Minimum top‑up is £20'
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.DOMAIN}/cancel`,
      metadata: { userId }        // optional: lets you identify the user later
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err);
    res.status(500).json({ error: err.message });
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
