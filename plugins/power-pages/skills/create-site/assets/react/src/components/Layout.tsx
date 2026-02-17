import { type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation()

  return (
    <div className="app">
      <header className="header">
        <nav className="nav">
          <Link to="/" className="logo">__SITE_NAME__</Link>
          <div className="nav-links">
            <Link to="/" className={location.pathname === '/' ? 'active' : ''}>Home</Link>
            <Link to="/about" className={location.pathname === '/about' ? 'active' : ''}>About</Link>
          </div>
        </nav>
      </header>
      <main className="main">{children}</main>
      <footer className="footer">
        <p>&copy; {new Date().getFullYear()} __SITE_NAME__</p>
      </footer>
    </div>
  )
}
