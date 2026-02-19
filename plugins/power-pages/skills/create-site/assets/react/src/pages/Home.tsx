import { useEffect } from 'react'

export default function Home() {
  useEffect(() => {
    const intervals: number[] = []
    const timeouts: number[] = []

    const particlesEl = document.getElementById('particles')
    const connectorsEl = document.getElementById('connectors')
    const statusArea = document.getElementById('statusArea')
    const progressTrack = document.getElementById('progressTrack')
    const progressLabel = document.getElementById('progressLabel')
    const mainHeading = document.getElementById('mainHeading')
    const centerStage = document.getElementById('centerStage')
    const tipTextEl = document.getElementById('tipText')

    // Particles
    function createParticle() {
      if (!particlesEl) return
      const p = document.createElement('div')
      p.classList.add('particle')
      const size = Math.random() * 3 + 1
      const colors = ['var(--pp-lavender)', 'var(--pp-periwinkle)', 'var(--pp-sky)', 'var(--pp-purple)']
      const color = colors[Math.floor(Math.random() * colors.length)]
      p.style.cssText = `width:${size}px;height:${size}px;left:${Math.random() * 100}%;background:${color};box-shadow:0 0 ${size * 3}px ${color};animation-duration:${Math.random() * 15 + 12}s;animation-delay:${Math.random() * 10}s;`
      particlesEl.appendChild(p)
      timeouts.push(window.setTimeout(() => p.remove(), 30000))
    }
    for (let i = 0; i < 30; i++) timeouts.push(window.setTimeout(() => createParticle(), i * 200))
    intervals.push(window.setInterval(createParticle, 800))

    // Connectors
    function createConnector() {
      if (!connectorsEl) return
      const c = document.createElement('div')
      c.classList.add('connector')
      c.style.cssText = `top:${Math.random() * 100}%;width:${Math.random() * 300 + 200}px;animation-duration:${Math.random() * 4 + 4}s;animation-delay:${Math.random() * 6}s;`
      connectorsEl.appendChild(c)
      timeouts.push(window.setTimeout(() => c.remove(), 12000))
    }
    for (let i = 0; i < 8; i++) timeouts.push(window.setTimeout(() => createConnector(), i * 1500))
    intervals.push(window.setInterval(createConnector, 2000))

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

    function showStatus(index: number) {
      if (!statusArea) return
      const existing = statusArea.querySelector('.status-message')
      if (existing) {
        existing.classList.remove('active')
        existing.classList.add('exiting')
        timeouts.push(window.setTimeout(() => existing.remove(), 700))
      }
      if (index >= statuses.length) return
      const msg = document.createElement('div')
      msg.classList.add('status-message')
      const icon = document.createElement('div')
      icon.classList.add('status-icon', 'working')
      msg.appendChild(icon)
      const text = document.createElement('span')
      text.textContent = statuses[index].text
      msg.appendChild(text)
      statusArea.appendChild(msg)
      requestAnimationFrame(() => requestAnimationFrame(() => msg.classList.add('active')))
      if (progressLabel) {
        const phaseIndex = Math.min(Math.floor((index / statuses.length) * phaseLabels.length), phaseLabels.length - 1)
        progressLabel.textContent = phaseLabels[phaseIndex]
      }
    }

    function onComplete() {
      if (progressTrack) progressTrack.classList.add('complete')
      if (progressLabel) { progressLabel.textContent = 'Complete!'; progressLabel.style.color = 'rgba(100, 200, 150, 0.7)' }
      const existing = statusArea?.querySelector('.status-message')
      if (existing) { existing.classList.remove('active'); existing.classList.add('exiting'); timeouts.push(window.setTimeout(() => existing.remove(), 700)) }
      timeouts.push(window.setTimeout(() => {
        if (!statusArea) return
        const msg = document.createElement('div')
        msg.classList.add('status-message')
        const icon = document.createElement('div')
        icon.classList.add('status-icon', 'done')
        msg.appendChild(icon)
        const text = document.createElement('span')
        text.textContent = 'Your site is ready!'
        text.style.color = '#64C896'
        msg.appendChild(text)
        statusArea.appendChild(msg)
        requestAnimationFrame(() => msg.classList.add('active'))
        if (mainHeading) mainHeading.textContent = 'Your site is ready'
        if (centerStage) centerStage.classList.add('complete')
      }, 800))
    }

    function advanceStatus() {
      if (currentStatusIndex >= statuses.length) return
      showStatus(currentStatusIndex)
      const duration = statuses[currentStatusIndex].duration
      timeouts.push(window.setTimeout(() => {
        currentStatusIndex++
        if (currentStatusIndex < statuses.length) advanceStatus()
        else onComplete()
      }, duration))
    }

    timeouts.push(window.setTimeout(() => advanceStatus(), 2000))

    // Feature cards
    timeouts.push(window.setTimeout(() => {
      document.querySelectorAll('.feature-card').forEach(card => {
        const delay = parseInt((card as HTMLElement).dataset.delay || '0')
        timeouts.push(window.setTimeout(() => card.classList.add('visible'), delay))
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
    function showTip() {
      if (!tipTextEl) return
      tipTextEl.style.opacity = '0'
      tipTextEl.style.transform = 'translateY(8px)'
      timeouts.push(window.setTimeout(() => {
        tipTextEl.textContent = tips[tipIndex % tips.length]
        tipTextEl.style.opacity = '1'
        tipTextEl.style.transform = 'translateY(0)'
        tipIndex++
      }, 500))
    }
    timeouts.push(window.setTimeout(() => showTip(), 3500))
    intervals.push(window.setInterval(showTip, 12000))

    return () => {
      intervals.forEach(id => clearInterval(id))
      timeouts.forEach(id => clearTimeout(id))
    }
  }, [])

  return (
    <div className="loading-wrapper">
      <div className="ambient" />
      <div className="grid-overlay" />
      <div className="scanline" />
      <div className="particles" id="particles" />
      <div className="connector-lines" id="connectors" />

      <div className="center-stage" id="centerStage">
        <div className="orbit-system">
          <div className="core-glow" />
          <div className="core-shape">
            <div className="slab" />
            <div className="slab" />
            <div className="slab" />
          </div>
          <div className="orbit-ring" />
          <div className="orbit-ring" />
          <div className="orbit-ring" />
          <div className="orbit-dot" />
          <div className="orbit-dot" />
          <div className="orbit-dot" />
        </div>

        <div className="text-content">
          <div className="brand-title">Power Pages</div>
          <div className="main-heading" id="mainHeading">Building __SITE_NAME__</div>

          <div className="status-area" id="statusArea" />

          <div className="progress-container">
            <div className="progress-track" id="progressTrack">
              <div className="progress-fill" />
            </div>
            <span className="progress-label-text" id="progressLabel">Initializing...</span>
          </div>
        </div>

        <div className="feature-cards">
          <div className="feature-card" data-delay="0">
            <span className="feature-card-icon">{ '\uD83D\uDD12' }</span>
            <span className="feature-card-label">Enterprise-grade security</span>
          </div>
          <div className="feature-card" data-delay="400">
            <span className="feature-card-icon">{ '\u26A1' }</span>
            <span className="feature-card-label">Lightning-fast performance</span>
          </div>
          <div className="feature-card" data-delay="800">
            <span className="feature-card-icon">{ '\uD83C\uDF10' }</span>
            <span className="feature-card-label">Ready to scale globally</span>
          </div>
        </div>

        <div className="tip-area">
          <div className="tip-label">Did you know</div>
          <div className="tip-text" id="tipText" />
        </div>
      </div>
    </div>
  )
}
