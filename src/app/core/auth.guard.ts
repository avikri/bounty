import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Router, RouterStateSnapshot } from '@angular/router';
import { map, take } from 'rxjs';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = (
  _route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot,
) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.currentUser$.pipe(
    take(1),
    map(user =>
      user !== null
        ? true
        // Preserve where the user was headed so login can send them back.
        // `login.page` reads this `redirect` query param after sign-in.
        : router.createUrlTree(['/login'], { queryParams: { redirect: state.url } })),
  );
};
