// YD Job Hub configuration. See config.example.js for why this file is committed.
//
// Analytics was deliberately left out of the console's snippet: it is a second
// SDK to download, it sets a measurement cookie, and nobody is going to read
// usage reports for a one-person tool.

window.YD_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyB10FTdHE2Hr-VGNJ9Uo5i2pGU2kdxdfhE',
    authDomain: 'yd-job-hub.firebaseapp.com',
    projectId: 'yd-job-hub',
    storageBucket: 'yd-job-hub.firebasestorage.app',
    messagingSenderId: '147632184660',
    appId: '1:147632184660:web:07992ead2cdcbac66efcc1',
  },

  // Bootstraps as owner on first sign-in. Must match OWNER in firestore.rules.
  // Use the ydexteriorvisions.com address, not the older gmail one.
  ownerEmail: 'jonahlinfield@ydexteriorvisions.com',

  // The service that holds the Anthropic API key and talks to Claude. Safe to
  // publish -- it refuses anyone who is not signed in as the owner. The key
  // itself lives only on Google's servers, never here.
  claudeEndpoint: 'https://yd-claude-147632184660.us-central1.run.app',
};
