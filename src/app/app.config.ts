import { ApplicationConfig } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideFirebaseApp, initializeApp, getApp } from '@angular/fire/app';
import {
  provideAuth, getAuth, connectAuthEmulator,
  signInWithEmailAndPassword, signOut,
} from '@angular/fire/auth';
import { provideFirestore, getFirestore, connectFirestoreEmulator } from '@angular/fire/firestore';
import { provideFunctions, getFunctions, connectFunctionsEmulator } from '@angular/fire/functions';
import { provideStorage, getStorage, connectStorageEmulator } from '@angular/fire/storage';
import { APP_ROUTES } from './app.routes';
import { environment } from '../environments/environment';

const useEmulators = (environment as { useEmulators?: boolean }).useEmulators === true;

/**
 * Test-only sign-in bridge for Playwright E2E. The login UI only offers Google
 * / Apple OAuth popups (which can't run headless), so E2E specs need a
 * programmatic email/password path against the Auth emulator. This is installed
 * ONLY when `useEmulators` is true — i.e. exclusively in the `e2e` build — so it
 * can never reach a production bundle.
 */
function installE2EAuthHook(auth: ReturnType<typeof getAuth>): void {
  if (!useEmulators || typeof window === 'undefined') return;
  (window as unknown as { __e2e?: unknown }).__e2e = {
    signIn: (email: string, password: string) =>
      signInWithEmailAndPassword(auth, email, password),
    signOut: () => signOut(auth),
    uid: () => auth.currentUser?.uid ?? null,
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(APP_ROUTES, withComponentInputBinding()),
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideAuth(() => {
      const a = getAuth();
      if (useEmulators) connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
      installE2EAuthHook(a);
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
