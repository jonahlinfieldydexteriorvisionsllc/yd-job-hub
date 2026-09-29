// Copy this file to config.js and fill in your own values.
//
// config.js IS committed to the repo on purpose. The Firebase web config is
// public by design -- it ships inside the JavaScript of every Firebase web app,
// and anyone can read it from a deployed site. Hiding it buys nothing, and a
// missing config.js would leave the GitHub Pages build unable to start at all.
//
// What actually protects the data is firestore.rules plus the authorized-domains
// list in the Firebase console.
//
// Genuine secrets -- the Trello API token in particular -- must NOT go in here.

window.YD_CONFIG = {
  // Firebase console -> Project settings -> Your apps -> Web app -> Config
  firebase: {
    apiKey: 'YOUR_API_KEY',
    authDomain: 'your-project.firebaseapp.com',
    projectId: 'your-project',
    storageBucket: 'your-project.firebasestorage.app',
    messagingSenderId: '000000000000',
    appId: '1:000000000000:web:0000000000000000000000',
  },

  // The one account that bootstraps itself as owner on first sign-in.
  // Must match the OWNER constant in firestore.rules exactly -- the rules file
  // is the real enforcement; this copy only drives the client.
  ownerEmail: 'you@example.com',
};
