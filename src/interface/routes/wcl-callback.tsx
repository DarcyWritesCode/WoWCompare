import { completeLogin } from 'common/wclV2/auth';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/** OAuth redirect target for the Warcraft Logs v2 PKCE login. */
export function Component() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    completeLogin(window.location.search)
      .then((redirect) => navigate(redirect, { replace: true }))
      .catch((err: Error) => setError(err.message));
  }, [navigate]);

  return (
    <div className="container" style={{ padding: 40 }}>
      {error ? <p>Warcraft Logs login failed: {error}</p> : <p>Logging in to Warcraft Logs…</p>}
    </div>
  );
}
