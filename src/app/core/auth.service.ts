import { Injectable, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  Auth,
  authState,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  User as FbUser,
} from '@angular/fire/auth';
import {
  Firestore,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { User } from './models';

/**
 * Hash function for picking a stable avatar variant from a uid.
 */
function pickVariant(uid: string): 1 | 2 | 3 | 4 | 5 {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

function deriveHandle(email: string | null): string {
  if (!email) return 'user';
  return (email.split('@')[0] ?? 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function initials(name: string | null): string {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts[1]?.[0] ?? '';
  return (first + last).toUpperCase() || (parts[0]?.slice(0, 2) ?? '??').toUpperCase();
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(Auth);
  private readonly firestore = inject(Firestore);

  /** Firebase user — null when signed out. */
  private readonly _fbUser = signal<FbUser | null>(null);
  /** Mapped app-level user (after Firestore profile is loaded). */
  private readonly _user = signal<User | null>(null);

  readonly user = this._user.asReadonly();
  readonly fbUser = this._fbUser.asReadonly();

  readonly currentUser$: Observable<FbUser | null> = authState(this.auth);

  /** For the existing route guard. */
  get isAuthenticated(): boolean {
    return this._fbUser() !== null;
  }

  constructor() {
    // Subscribe once at construction; signal stays in sync with Firebase Auth.
    this.currentUser$.subscribe(async (fbUser) => {
      this._fbUser.set(fbUser);
      if (!fbUser) { this._user.set(null); return; }
      try {
        const profile = await this.ensureUserDoc(fbUser);
        this._user.set(profile);
      } catch (err) {
        console.error('[AuthService] ensureUserDoc failed', err);
      }
    });
  }

  async signInWithGoogle(): Promise<void> {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(this.auth, provider);
  }

  async signInWithApple(): Promise<void> {
    const provider = new OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');
    await signInWithPopup(this.auth, provider);
  }

  /** Legacy alias used by older code paths — wires through to Google. */
  signIn(): Promise<void> { return this.signInWithGoogle(); }

  async signOut(): Promise<void> {
    await fbSignOut(this.auth);
  }

  /**
   * Create users/{uid} if missing; otherwise return the existing doc.
   * Mirrors the spec's `users/{userId}` schema.
   */
  private async ensureUserDoc(fbUser: FbUser): Promise<User> {
    const ref = doc(this.firestore, 'users', fbUser.uid);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      const displayName = fbUser.displayName ?? deriveHandle(fbUser.email) ?? 'New user';
      const handle = deriveHandle(fbUser.email);
      const seed = {
        uid: fbUser.uid,
        displayName,
        handle,
        photoURL: fbUser.photoURL ?? null,
        groupIds: [] as string[],
        totalPoints: 0,
        createdAt: serverTimestamp(),
      };
      await setDoc(ref, seed);
      return {
        uid: fbUser.uid,
        displayName,
        handle,
        initials: initials(displayName),
        avatarVariant: pickVariant(fbUser.uid),
        totalPoints: 0,
      };
    }

    const data = snap.data() as {
      displayName: string; handle: string; totalPoints?: number;
    };
    return {
      uid: fbUser.uid,
      displayName: data.displayName,
      handle: data.handle,
      initials: initials(data.displayName),
      avatarVariant: pickVariant(fbUser.uid),
      totalPoints: data.totalPoints ?? 0,
    };
  }
}
