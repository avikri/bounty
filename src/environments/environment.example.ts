// Copy this file to environment.ts (production) and environment.development.ts (dev).
// Fill in values from Firebase Console → Project settings → Your apps → Web app.
export const environment = {
  production: true,
  firebase: {
    apiKey:            '',
    authDomain:        '',
    projectId:         '',
    storageBucket:     '',
    messagingSenderId: '',
    appId:             '',
  },
  // reCAPTCHA Enterprise site key for App Check (required in production).
  appCheckSiteKey: '',
};
