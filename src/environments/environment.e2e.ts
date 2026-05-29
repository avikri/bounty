// E2E environment — used by the `e2e` build/serve configuration only
// (angular.json fileReplacements). Identical Firebase config to the other
// environments but with `useEmulators: true`, so the app talks to the local
// Auth/Firestore/Functions/Storage emulators and exposes the test-only
// `window.__e2e` sign-in hook (see app.config.ts). Never shipped to prod.
export const environment = {
  production: false,
  firebase: {
    // Placeholder key — the emulators accept any value, so no real key is committed.
    apiKey:            'demo-emulator-key',
    authDomain:        'bounty-c5ee6.firebaseapp.com',
    projectId:         'bounty-c5ee6',
    storageBucket:     'bounty-c5ee6.firebasestorage.app',
    messagingSenderId: '1018038143311',
    appId:             '1:1018038143311:web:d1b7cc743f766a63009d3a',
  },
  useEmulators: true,
};
