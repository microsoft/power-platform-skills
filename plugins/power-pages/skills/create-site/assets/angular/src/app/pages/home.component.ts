import { Component, AfterViewInit, OnDestroy } from '@angular/core'

@Component({
  selector: 'app-home',
  standalone: true,
  template: `
    <div class="loading-wrapper">
      <div class="ambient"></div>
      <div class="grid-overlay"></div>
      <div class="scanline"></div>
      <div class="particles" id="particles"></div>
      <div class="connector-lines" id="connectors"></div>

      <div class="center-stage" id="centerStage">
        <div class="orbit-system">
          <div class="core-glow"></div>
          <div class="core-shape">
            <div class="slab"></div>
            <div class="slab"></div>
            <div class="slab"></div>
          </div>
          <div class="orbit-ring"></div>
          <div class="orbit-ring"></div>
          <div class="orbit-ring"></div>
          <div class="orbit-dot"></div>
          <div class="orbit-dot"></div>
          <div class="orbit-dot"></div>
        </div>

        <div class="text-content">
          <div class="brand-title">Power Pages</div>
          <div class="main-heading" id="mainHeading">Building __SITE_NAME__</div>

          <div class="status-area" id="statusArea"></div>

          <div class="progress-container">
            <div class="progress-track" id="progressTrack">
              <div class="progress-fill"></div>
            </div>
            <span class="progress-label-text" id="progressLabel">Initializing...</span>
          </div>
        </div>

        <div class="feature-cards">
          <div class="feature-card" data-delay="0">
            <span class="feature-card-icon">&#x1F512;</span>
            <span class="feature-card-label">Enterprise-grade security</span>
          </div>
          <div class="feature-card" data-delay="400">
            <span class="feature-card-icon">&#x26A1;</span>
            <span class="feature-card-label">Lightning-fast performance</span>
          </div>
          <div class="feature-card" data-delay="800">
            <span class="feature-card-icon">&#x1F310;</span>
            <span class="feature-card-label">Ready to scale globally</span>
          </div>
        </div>

        <div class="tip-area">
          <div class="tip-label">Did you know</div>
          <div class="tip-text" id="tipText"></div>
        </div>
      </div>
    </div>
  `,
})
export class HomeComponent implements AfterViewInit, OnDestroy {
  private intervals: number[] = []
  private timeouts: number[] = []

  ngAfterViewInit() {
    const particlesEl = document.getElementById('particles')
    const connectorsEl = document.getElementById('connectors')
    const statusArea = document.getElementById('statusArea')
    const progressLabel = document.getElementById('progressLabel')
    const tipTextEl = document.getElementById('tipText')

    // Particles
    const createParticle = () => {
      if (!particlesEl) return
      const p = document.createElement('div')
      p.classList.add('particle')
      const size = Math.random() * 3 + 1
      const colors = ['var(--pp-lavender)', 'var(--pp-periwinkle)', 'var(--pp-sky)', 'var(--pp-purple)']
      const color = colors[Math.floor(Math.random() * colors.length)]
      p.style.cssText = `width:${size}px;height:${size}px;left:${Math.random() * 100}%;background:${color};box-shadow:0 0 ${size * 3}px ${color};animation-duration:${Math.random() * 15 + 12}s;animation-delay:${Math.random() * 10}s;`
      particlesEl.appendChild(p)
      this.timeouts.push(window.setTimeout(() => p.remove(), 30000))
    }
    for (let i = 0; i < 30; i++) this.timeouts.push(window.setTimeout(() => createParticle(), i * 200))
    this.intervals.push(window.setInterval(createParticle, 800))

    // Connectors
    const createConnector = () => {
      if (!connectorsEl) return
      const c = document.createElement('div')
      c.classList.add('connector')
      c.style.cssText = `top:${Math.random() * 100}%;width:${Math.random() * 300 + 200}px;animation-duration:${Math.random() * 4 + 4}s;animation-delay:${Math.random() * 6}s;`
      connectorsEl.appendChild(c)
      this.timeouts.push(window.setTimeout(() => c.remove(), 12000))
    }
    for (let i = 0; i < 8; i++) this.timeouts.push(window.setTimeout(() => createConnector(), i * 1500))
    this.intervals.push(window.setInterval(createConnector, 2000))

    // Status messages
    const statuses = [
      { text: 'Setting up your workspace', duration: 8000 },
      { text: 'Installing dependencies', duration: 10000 },
      { text: 'Configuring build tools', duration: 12000 },
      { text: 'Loading design system', duration: 14000 },
      { text: 'Preparing components', duration: 10000 },
      { text: 'Building page templates', duration: 8000 },
      { text: 'Setting up routing', duration: 12000 },
      { text: 'Applying design tokens', duration: 10000 },
      { text: 'Optimizing assets', duration: 10000 },
      { text: 'Running final checks', duration: 12000 },
      { text: 'Polishing details', duration: 8000 },
      { text: 'Almost there...', duration: 6000 },
    ]

    const phaseLabels = [
      'Getting started...', 'Setting up infrastructure...', 'Building your pages...',
      'Configuring features...', 'Optimizing & securing...', 'Final steps...',
    ]

    let currentStatusIndex = 0

    const showStatus = (index: number) => {
      if (!statusArea) return
      const existing = statusArea.querySelector('.status-message')
      if (existing) {
        existing.classList.remove('active')
        existing.classList.add('exiting')
        this.timeouts.push(window.setTimeout(() => existing.remove(), 700))
      }
      const msg = document.createElement('div')
      msg.classList.add('status-message')
      const icon = document.createElement('div')
      icon.classList.add('status-icon', 'working')
      msg.appendChild(icon)
      const text = document.createElement('span')
      text.textContent = statuses[index % statuses.length].text
      msg.appendChild(text)
      statusArea.appendChild(msg)
      requestAnimationFrame(() => requestAnimationFrame(() => msg.classList.add('active')))
      if (progressLabel) {
        const phaseIndex = Math.min(Math.floor((index / statuses.length) * phaseLabels.length), phaseLabels.length - 1)
        progressLabel.textContent = phaseLabels[phaseIndex]
      }
    }

    const advanceStatus = () => {
      showStatus(currentStatusIndex % statuses.length)
      const duration = statuses[currentStatusIndex % statuses.length].duration
      this.timeouts.push(window.setTimeout(() => {
        currentStatusIndex++
        advanceStatus()
      }, duration))
    }

    this.timeouts.push(window.setTimeout(() => advanceStatus(), 2000))

    // Feature cards
    this.timeouts.push(window.setTimeout(() => {
      document.querySelectorAll('.feature-card').forEach(card => {
        const delay = parseInt((card as HTMLElement).dataset['delay'] || '0')
        this.timeouts.push(window.setTimeout(() => card.classList.add('visible'), delay))
      })
    }, 2500))

    // Tips
    const tips = [
      'Power Pages sites are built on Microsoft Dataverse, giving you enterprise-level data capabilities from day one.',
      'Your site automatically includes responsive design \u2014 it looks great on phones, tablets, and desktops.',
      'With role-based security, you can control exactly who sees what on your site.',
      'Power Pages integrates seamlessly with Power Automate, Power BI, and the entire Microsoft ecosystem.',
      'You can extend your site with custom code, and JavaScript for unlimited flexibility.',
      'Built-in content delivery networks ensure your pages load fast for users worldwide.',
      'Multi-language support lets you reach audiences across the globe with localized content.',
    ]

    let tipIndex = 0
    const showTip = () => {
      if (!tipTextEl) return
      tipTextEl.style.opacity = '0'
      tipTextEl.style.transform = 'translateY(8px)'
      this.timeouts.push(window.setTimeout(() => {
        tipTextEl.textContent = tips[tipIndex % tips.length]
        tipTextEl.style.opacity = '1'
        tipTextEl.style.transform = 'translateY(0)'
        tipIndex++
      }, 500))
    }
    this.timeouts.push(window.setTimeout(() => showTip(), 3500))
    this.intervals.push(window.setInterval(showTip, 12000))
  }

  ngOnDestroy() {
    this.intervals.forEach(id => clearInterval(id))
    this.timeouts.forEach(id => clearTimeout(id))
  }
}
