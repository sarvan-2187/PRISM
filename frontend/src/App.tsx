import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import Landing from './pages/Landing';
import Pay from './pages/Pay';
import Review from './pages/Review';
import Verify from './pages/Verify';
import Status from './pages/Status';
import Timeline from './pages/Timeline';

/**
 * Route map. Each screen is one step of the payment flow, in order:
 *   /          sign in with a passkey
 *   /pay       choose a payee and an amount        (intent is locked here)
 *   /pay/:id   server-authoritative review + approve
 *   /pay/:id/verify   semantic step-up, when risk demands it
 *   /pay/:id/status   outcome
 *   /pay/:id/timeline security timeline for that transaction
 */
export default function App() {
  const { pathname } = useLocation();

  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>
            PRISM<span className="brand-sub">Payment Risk &amp; Intent Security Model</span>
          </span>
        </Link>
        {pathname !== '/' && (
          <Link to="/pay" className="link-quiet">
            New payment
          </Link>
        )}
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/pay" element={<Pay />} />
          <Route path="/pay/:txId" element={<Review />} />
          <Route path="/pay/:txId/verify" element={<Verify />} />
          <Route path="/pay/:txId/status" element={<Status />} />
          <Route path="/pay/:txId/timeline" element={<Timeline />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="app-footer">
        Demo system. Money is internal to PRISM and no real payment rail is involved.
      </footer>
    </div>
  );
}
