import { ApplicationConfig } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideFirebaseApp, initializeApp, getApp } from '@angular/fire/app';
import { provideAuth, getAuth, connectAuthEmulator } from '@angular/fire/auth';
import { provideFirestore, getFirestore, connectFirestoreEmulator } from '@angular/fire/firestore';
import { provideFunctions, getFunctions, connectFunctionsEmulator } from '@angular/fire/functions';
import { provideStorage, getStorage, connectStorageEmulator } from '@angular/fire/storage';
import { APP_ROUTES } from './app.routes';
import { environment } from '../environments/environment';

const useEmulators = (environment as { useEmulators?: boolean }).useEmulators === true;

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(APP_ROUTES, withComponentInputBinding()),
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideAuth(() => {
      const a = getAuth();
      if (useEmulators) connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
      return a;
    }),
    provideFirestore(() => {
      const f = getFirestore();
      if (useEmulators) connectFirestoreEmulator(f, '127.0.0.1', 8080);
      return f;
    }),
    provideFunctions(() => {
      const fn = getFunctions(getApp(), 'australia-southeast1');
      if (useEmulators) connectFunctionsEmulator(fn, '127.0.0.1', 5001);
      return fn;
    }),
    provideStorage(() => {
      const s = getStorage();
      if (useEmulators) connectStorageEmulator(s, '127.0.0.1', 9199);
      return s;
    }),
  ],
};
