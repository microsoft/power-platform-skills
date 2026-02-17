export default function Home() {
  return (
    <div className="page">
      <section className="hero">
        <h1>__SITE_NAME__</h1>
        <p className="hero-subtitle">__SITE_DESCRIPTION__</p>
        <div className="hero-actions">
          <a href="#features" className="btn btn-primary">Get Started</a>
          <a href="/about" className="btn btn-secondary">Learn More</a>
        </div>
      </section>

      <section id="features" className="features">
        <h2>Features</h2>
        <div className="feature-grid">
          <div className="feature-card">
            <h3>Fast &amp; Modern</h3>
            <p>Built with the latest web technologies for optimal performance.</p>
          </div>
          <div className="feature-card">
            <h3>Responsive Design</h3>
            <p>Looks great on every device, from desktop to mobile.</p>
          </div>
          <div className="feature-card">
            <h3>Easy to Customize</h3>
            <p>Theme system with CSS custom properties for quick styling.</p>
          </div>
        </div>
      </section>
    </div>
  )
}
