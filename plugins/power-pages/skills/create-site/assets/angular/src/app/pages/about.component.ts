import { Component } from '@angular/core'

@Component({
  selector: 'app-about',
  standalone: true,
  template: `
    <div class="page">
      <h1>About</h1>
      <p>Learn more about __SITE_NAME__ and what we do.</p>
    </div>
  `,
})
export class AboutComponent {}
