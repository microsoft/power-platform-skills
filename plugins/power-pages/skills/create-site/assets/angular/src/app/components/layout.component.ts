import { Component } from '@angular/core'
import { RouterLink, RouterLinkActive } from '@angular/router'

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <div class="app">
      <header class="header">
        <nav class="nav">
          <a routerLink="/" class="logo">__SITE_NAME__</a>
          <div class="nav-links">
            <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Home</a>
            <a routerLink="/about" routerLinkActive="active">About</a>
          </div>
        </nav>
      </header>
      <main class="main">
        <ng-content />
      </main>
      <footer class="footer">
        <p>&copy; {{ year }} __SITE_NAME__</p>
      </footer>
    </div>
  `,
})
export class LayoutComponent {
  year = new Date().getFullYear()
}
