import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const APP_ROUTES: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'join/:code',
    loadComponent: () => import('./features/groups/join-by-code.page').then((m) => m.JoinByCodePage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/app-shell.component').then((m) => m.AppShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'groups' },
      {
        path: 'groups',
        loadComponent: () => import('./features/groups/group-list.page').then((m) => m.GroupListPage),
      },
      {
        path: 'reviews',
        loadComponent: () => import('./features/reviews/review-queue.page').then((m) => m.ReviewQueuePage),
      },
      {
        path: 'inbox',
        loadComponent: () => import('./features/inbox/inbox.page').then((m) => m.InboxPage),
      },
      {
        path: 'u/:userId',
        loadComponent: () => import('./features/profile/user-profile.page').then((m) => m.UserProfilePage),
      },
      {
        path: 'g/:groupId',
        children: [
          {
            path: '',
            loadComponent: () => import('./features/bounties/feed.page').then((m) => m.BountyFeedPage),
          },
          {
            path: 'new',
            loadComponent: () => import('./features/bounties/create.page').then((m) => m.CreateBountyPage),
          },
          {
            path: 'leaderboard',
            loadComponent: () => import('./features/leaderboard/leaderboard.page').then((m) => m.LeaderboardPage),
          },
          {
            path: 'settings',
            loadComponent: () => import('./features/groups/group-settings.page').then((m) => m.GroupSettingsPage),
          },
          {
            path: 'b/:bountyId',
            children: [
              {
                path: '',
                loadComponent: () => import('./features/bounties/detail.page').then((m) => m.BountyDetailPage),
              },
              {
                path: 'submit',
                loadComponent: () => import('./features/bounties/claim-submit.page').then((m) => m.ClaimSubmitPage),
              },
            ],
          },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '/groups' },
];
