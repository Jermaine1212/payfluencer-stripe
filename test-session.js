// test-session.js
// Quick script to test the live create-checkout-session endpoint

const fetch = require('node-fetch');

const URL = 'https://payfluencer-stripe.onrender.com/create-checkout-session';

(async () => {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountPounds: '50',
        userId: 'test_user_123'
      })
    });
    console.log('Status:', res.status);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      console.log('Body:', data);
    } else {
      const text = await res.text();
      console.log('Body (text):', text);
    }
  } catch (err) {
    console.error('Error during test:', err);
  }
})();