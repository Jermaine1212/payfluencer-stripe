// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
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

// Log every request for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Add a root route to verify server is running
app.get('/', (req, res) => {
  res.send('Server is running!');
});

// Initialise Stripe with your secret key from .env
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());   // built‑in JSON parser
/**
 * 1️⃣  CREATE CHECKOUT SESSION
 * Expects JSON body: { "priceId": "...", "userId": "..." }
 * Returns: { url: "https://checkout.stripe.com/..." }
 */
app.post('/create-checkout-session', async (req, res) => {
  // req is defined here by Express
  try {
    const { priceId, userId } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: 'priceId missing' });
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

/**
 * 2️⃣  STRIPE WEBHOOK ENDPOINT
 * Exposes /webhook for Stripe to POST events to.
 * IMPORTANT: this route uses raw body parsing!
 */
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json' }),
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

    // Handle the event you care about
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // 🔥 TODO: Update the user’s wallet balance in your DB here
      console.log(
        `Top‑up successful for user ${session.metadata.userId}; amount: £${(
          session.amount_total / 100
        ).toFixed(2)}`
      );
    }

    res.sendStatus(200);
  }
);


// Start server
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Stripe mode: ${process.env.STRIPE_SECRET_KEY.startsWith('sk_test') ? 'TEST' : 'LIVE'}`);
  console.log(`Domain: ${process.env.DOMAIN}`);
});
