/**
 * Landing / passkey sign-in.   OWNER: S4
 *
 * This screen is complete and is the reference for how every other page
 * should talk to the backend: call `api.*`, catch `ApiError`, switch on
 * `failureCode`. Copy this shape rather than inventing a new one.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api-client';
import { webauthn, describeWebAuthnError } from '../lib/webauthn-client';

const DEMO_USERS = [
  { email: 'asha@prism.demo', name: 'Asha Menon' },
  { email: 'priya@prism.demo', name: 'Priya Sharma' },
];

export default function Landing() {
  const navigate = useNavigate();
  const [email, setEmail] = useState(DEMO_USERS[0].email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(webauthn.supported());
    // Already signed in? Skip straight to paying.
    api.me().then(
      () => navigate('/pay', { replace: true }),
      () => undefined
    );
  }, [navigate]);

  async function run(mode: 'register' | 'login') {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        const options = await api.registerOptions(email);
        const response = await webauthn.register(options);
        await api.registerVerify(email, response);
      } else {
        const options = await api.loginOptions(email);
        const response = await webauthn.approve(options);
        await api.loginVerify(email, response);
      }
      navigate('/pay');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.failureCode}: ${err.message}`
          : describeWebAuthnError(err)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>Sign in with a passkey</h1>
      <p className="muted">
        No PIN, no OTP. A private key stays in this device&rsquo;s secure hardware and never
        reaches PRISM &mdash; we only ever see a signature.
      </p>

      {!supported && (
        <div className="error">
          This browser does not support WebAuthn. Use Chrome, Edge, or Safari over
          <code> http://localhost</code>.
        </div>
      )}

      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="email">Demo account</label>
        <select id="email" value={email} onChange={(e) => setEmail(e.target.value)}>
          {DEMO_USERS.map((u) => (
            <option key={u.email} value={u.email}>
              {u.name} — {u.email}
            </option>
          ))}
        </select>
      </div>

      <button onClick={() => run('login')} disabled={busy || !supported}>
        {busy ? 'Waiting for passkey…' : 'Sign in'}
      </button>
      <button className="secondary" onClick={() => run('register')} disabled={busy || !supported}>
        Register a passkey on this device
      </button>

      {error && <div className="error">{error}</div>}

      <p className="muted" style={{ marginTop: 20 }}>
        First run on a new browser profile? Register first &mdash; a passkey is bound to one
        device, which is the point.
      </p>
    </div>
  );
}
