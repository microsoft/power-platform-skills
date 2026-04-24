import { useEffect } from 'react'

const loadingCSS = `
:root {
  --pp-violet: #7B5EA7;
  --pp-purple: #8B6FC0;
  --pp-lavender: #A78BDB;
  --pp-periwinkle: #8088D9;
  --pp-sky: #5A9BD5;
  --pp-deep-violet: #5C3D8F;
  --pp-bg: #F7F5FA;
  --pp-surface: #FFFFFF;
  --pp-text: #2D1B4E;
  --pp-text-secondary: #6B5A82;
  --pp-text-muted: #9B8FB5;
  --pp-border: rgba(139, 111, 192, 0.12);
  --pp-glow: rgba(139, 111, 192, 0.2);
}
html, body { overflow: hidden; background: var(--pp-bg); color: var(--pp-text); }
.loading-wrapper { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--pp-bg); }
.ambient { position: fixed; inset: 0; z-index: 0; overflow: hidden; }
.ambient::before {
  content: ''; position: absolute; width: 160%; height: 160%; top: -30%; left: -30%;
  background:
    radial-gradient(ellipse 600px 600px at 25% 30%, rgba(167, 139, 219, 0.12) 0%, transparent 70%),
    radial-gradient(ellipse 500px 500px at 75% 70%, rgba(90, 155, 213, 0.08) 0%, transparent 70%),
    radial-gradient(ellipse 800px 400px at 50% 50%, rgba(139, 111, 192, 0.06) 0%, transparent 60%);
  animation: ambientDrift 25s ease-in-out infinite alternate;
}
@keyframes ambientDrift {
  0% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(-3%, 2%) scale(1.04); }
  100% { transform: translate(2%, -1%) scale(0.98); }
}
.particles { position: fixed; inset: 0; z-index: 1; pointer-events: none; }
.particle { position: absolute; border-radius: 50%; opacity: 0; animation: particleFloat linear infinite; }
@keyframes particleFloat {
  0% { transform: translateY(100vh) scale(0); opacity: 0; }
  10% { opacity: 0.6; }
  90% { opacity: 0.6; }
  100% { transform: translateY(-10vh) scale(1); opacity: 0; }
}
.grid-overlay {
  position: fixed; inset: 0; z-index: 1;
  background-image: linear-gradient(rgba(139, 111, 192, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(139, 111, 192, 0.04) 1px, transparent 1px);
  background-size: 60px 60px; animation: gridPulse 8s ease-in-out infinite alternate;
}
@keyframes gridPulse { 0% { opacity: 0.3; } 100% { opacity: 0.7; } }
.center-stage { position: relative; z-index: 10; display: flex; flex-direction: column; align-items: center; gap: 36px; padding: 40px 40px 48px; max-height: 100vh; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
.center-stage::-webkit-scrollbar { display: none; }
.orbit-system { position: relative; width: 220px; height: 220px; display: flex; align-items: center; justify-content: center; }
.core-shape { position: absolute; width: 120px; height: 120px; z-index: 5; background: url('/power-pages-icon.png') center/contain no-repeat; animation: coreFloat 4s ease-in-out infinite; }
@keyframes coreFloat { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-3px) scale(1.025); } }
.core-glow { position: absolute; width: 130px; height: 130px; border-radius: 50%; background: radial-gradient(circle, rgba(167, 139, 219, 0.18) 0%, transparent 70%); z-index: 3; animation: coreGlow 3s ease-in-out infinite alternate; filter: blur(25px); }
@keyframes coreGlow { 0% { transform: scale(1); opacity: 0.5; } 100% { transform: scale(1.5); opacity: 0.9; } }
.orbit-ring { position: absolute; border: 1px solid rgba(139, 111, 192, 0.15); border-radius: 50%; animation: ringRotate linear infinite; }
.orbit-ring:nth-child(1) { width: 160px; height: 160px; animation-duration: 12s; }
.orbit-ring:nth-child(2) { width: 200px; height: 200px; animation-duration: 18s; animation-direction: reverse; border-color: rgba(90, 155, 213, 0.12); }
.orbit-ring:nth-child(3) { width: 240px; height: 240px; animation-duration: 25s; border-style: dashed; border-color: rgba(139, 111, 192, 0.08); }
@keyframes ringRotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.orbit-dot { position: absolute; width: 8px; height: 8px; border-radius: 50%; z-index: 6; }
.orbit-dot::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; filter: blur(6px); }
.orbit-dot:nth-child(4) { background: var(--pp-lavender); box-shadow: 0 0 10px rgba(167, 139, 219, 0.5); animation: orbitA 12s linear infinite; }
.orbit-dot:nth-child(4)::after { background: rgba(167, 139, 219, 0.4); }
.orbit-dot:nth-child(5) { background: var(--pp-sky); box-shadow: 0 0 10px rgba(90, 155, 213, 0.5); width: 6px; height: 6px; animation: orbitB 18s linear infinite reverse; }
.orbit-dot:nth-child(5)::after { background: rgba(90, 155, 213, 0.4); }
.orbit-dot:nth-child(6) { background: var(--pp-periwinkle); box-shadow: 0 0 8px rgba(128, 136, 217, 0.5); width: 5px; height: 5px; animation: orbitC 25s linear infinite; }
.orbit-dot:nth-child(6)::after { background: rgba(128, 136, 217, 0.4); }
@keyframes orbitA { from { transform: rotate(0deg) translateX(80px) rotate(0deg); } to { transform: rotate(360deg) translateX(80px) rotate(-360deg); } }
@keyframes orbitB { from { transform: rotate(0deg) translateX(100px) rotate(0deg); } to { transform: rotate(360deg) translateX(100px) rotate(-360deg); } }
@keyframes orbitC { from { transform: rotate(0deg) translateX(120px) rotate(0deg); } to { transform: rotate(360deg) translateX(120px) rotate(-360deg); } }
.text-content { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 20px; }
.brand-title { font-family: 'Outfit', sans-serif; font-weight: 300; font-size: 14px; letter-spacing: 4px; text-transform: uppercase; color: var(--pp-violet); opacity: 0; animation: fadeSlideUp 1s ease-out 0.5s forwards; }
.main-heading { font-family: 'Outfit', sans-serif; font-weight: 600; font-size: 32px; line-height: 1.3; background: linear-gradient(135deg, var(--pp-deep-violet) 0%, var(--pp-violet) 40%, var(--pp-sky) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; opacity: 0; animation: fadeSlideUp 1s ease-out 0.8s forwards; }
.status-area { height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; overflow: hidden; opacity: 0; animation: fadeSlideUp 1s ease-out 1.2s forwards; }
.status-message { position: absolute; white-space: nowrap; font-size: 15px; font-weight: 400; color: var(--pp-text-secondary); display: flex; align-items: center; gap: 10px; opacity: 0; transform: translateY(20px); transition: all 0.7s cubic-bezier(0.22, 1, 0.36, 1); }
.status-message.active { opacity: 1; transform: translateY(0); }
.status-message.exiting { opacity: 0; transform: translateY(-20px); }
.status-icon { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.status-icon.working { border: 2px solid rgba(139, 111, 192, 0.2); border-top-color: var(--pp-violet); animation: spin 1s linear infinite; }
.status-icon.done { background: rgba(34, 158, 92, 0.1); border: none; }
.status-icon.done::after { content: '\\2713'; font-size: 11px; color: #229E5C; font-weight: 600; }
@keyframes spin { to { transform: rotate(360deg); } }
.progress-container { width: 320px; opacity: 0; animation: fadeSlideUp 1s ease-out 1.5s forwards; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.progress-track { width: 100%; height: 3px; background: rgba(139, 111, 192, 0.1); border-radius: 4px; overflow: hidden; position: relative; }
.progress-fill { height: 100%; width: 40%; border-radius: 4px; background: linear-gradient(90deg, transparent, var(--pp-violet), var(--pp-lavender), var(--pp-sky), transparent); position: absolute; top: 0; left: -40%; animation: infiniteSlide 2s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
.progress-fill::after { content: ''; position: absolute; right: 10%; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--pp-sky); box-shadow: 0 0 8px rgba(90, 155, 213, 0.5), 0 0 16px rgba(90, 155, 213, 0.2); opacity: 0.9; }
@keyframes infiniteSlide { 0% { left: -40%; } 100% { left: 100%; } }
.progress-track.complete .progress-fill { width: 100%; left: 0; animation: none; background: linear-gradient(90deg, var(--pp-violet), var(--pp-lavender), var(--pp-sky)); transition: all 0.8s ease; }
.progress-track.complete .progress-fill::after { display: none; }
.progress-label-text { font-size: 12px; color: var(--pp-text-muted); font-family: 'DM Sans', sans-serif; letter-spacing: 0.3px; }
.feature-cards { display: flex; gap: 16px; margin-top: 16px; opacity: 0; animation: fadeSlideUp 1s ease-out 2s forwards; }
.feature-card { background: var(--pp-surface); border: 1px solid rgba(139, 111, 192, 0.1); border-radius: 16px; padding: 20px 22px; width: 150px; box-shadow: 0 2px 12px rgba(139, 111, 192, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04); opacity: 0; transform: translateY(20px) scale(0.95); transition: all 0.8s cubic-bezier(0.22, 1, 0.36, 1); }
.feature-card.visible { opacity: 1; transform: translateY(0) scale(1); }
.feature-card:hover { border-color: rgba(139, 111, 192, 0.2); box-shadow: 0 4px 24px rgba(139, 111, 192, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04); transform: translateY(-2px) scale(1.02); }
.feature-card-icon { font-size: 24px; margin-bottom: 10px; display: block; }
.feature-card-label { font-family: 'Outfit', sans-serif; font-size: 13px; font-weight: 500; color: var(--pp-text-secondary); line-height: 1.4; }
.connector-lines { position: fixed; inset: 0; z-index: 2; pointer-events: none; overflow: hidden; }
.connector { position: absolute; height: 1px; background: linear-gradient(90deg, transparent, rgba(139, 111, 192, 0.12), transparent); animation: connectorSweep 6s ease-in-out infinite; }
@keyframes connectorSweep { 0%, 100% { transform: translateX(-100%); opacity: 0; } 20% { opacity: 1; } 80% { opacity: 1; } 100% { transform: translateX(100vw); opacity: 0; } }
.scanline { position: fixed; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent 0%, var(--pp-lavender) 50%, transparent 100%); opacity: 0.06; z-index: 2; animation: scanDrop 8s linear infinite; pointer-events: none; }
@keyframes scanDrop { 0% { top: -2px; } 100% { top: 100%; } }
.tip-area { text-align: center; margin-top: 12px; opacity: 0; animation: fadeSlideUp 1s ease-out 3s forwards; }
.tip-label { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--pp-text-muted); margin-bottom: 8px; font-family: 'Outfit', sans-serif; }
.tip-text { font-size: 13px; color: var(--pp-text-muted); max-width: 380px; line-height: 1.6; margin: 0 auto; min-height: 42px; transition: opacity 0.6s ease, transform 0.6s ease; }
@keyframes fadeSlideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
.center-stage.complete .main-heading { animation: completePulse 2s ease-in-out infinite alternate; }
@keyframes completePulse { 0% { filter: brightness(1); } 100% { filter: brightness(1.15); } }
@media (max-width: 600px) { .main-heading { font-size: 24px; } .progress-container { width: 260px; } .feature-cards { flex-direction: column; align-items: center; } .orbit-system { width: 180px; height: 180px; } }
`

export default function Home() {
  useEffect(() => {
    const intervals: number[] = []
    const timeouts: number[] = []

    const particlesEl = document.getElementById('particles')
    const connectorsEl = document.getElementById('connectors')
    const statusArea = document.getElementById('statusArea')
    const progressLabel = document.getElementById('progressLabel')
    const tipTextEl = document.getElementById('tipText')

    // Particles
    function createParticle() {
      if (!particlesEl) return
      const p = document.createElement('div')
      p.classList.add('particle')
      const size = Math.random() * 3 + 1
      const colors = ['rgba(167,139,219,0.5)', 'rgba(128,136,217,0.5)', 'rgba(90,155,213,0.5)', 'rgba(139,111,192,0.5)']
      const color = colors[Math.floor(Math.random() * colors.length)]
      p.style.cssText = `width:${size}px;height:${size}px;left:${Math.random() * 100}%;background:${color};box-shadow:0 0 ${size * 2}px ${color};animation-duration:${Math.random() * 15 + 12}s;animation-delay:${Math.random() * 10}s;`
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

    function advanceStatus() {
      showStatus(currentStatusIndex % statuses.length)
      const duration = statuses[currentStatusIndex % statuses.length].duration
      timeouts.push(window.setTimeout(() => {
        currentStatusIndex++
        advanceStatus()
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
    <>
      <style>{loadingCSS}</style>
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
    </>
  )
}
