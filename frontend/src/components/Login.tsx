import { useState } from 'react';
import { c, radius, shadow, font } from '../theme';

interface Props {
  onLogin: (username: string, password: string, remember: boolean) => Promise<boolean>;
}

export function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    setLoading(true);
    setError('');
    try {
      const ok = await onLogin(username, password, remember);
      if (!ok) setError('Invalid username or password');
    } catch {
      setError('Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.logoWrap}>
          <h1 style={styles.title}>filebox</h1>
          <p style={styles.subtitle}>Sign in to your account</p>
        </div>
        <div style={styles.inputGroup}>
          <label style={styles.label}>Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your username"
            style={styles.input}
            autoFocus
            autoComplete="username"
          />
        </div>
        <div style={styles.inputGroup}>
          <label style={styles.label}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            style={styles.input}
            autoComplete="current-password"
          />
        </div>
        <label style={styles.rememberRow}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            style={styles.checkbox}
          />
          <span style={styles.rememberLabel}>Remember me for 30 days</span>
        </label>
        {error && (
          <div style={styles.errorBox}>
            <p style={styles.error}>{error}</p>
          </div>
        )}
        <button type="submit" disabled={loading || !username.trim() || !password.trim()} style={styles.button}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', background: c.bgSubtle,
    fontFamily: font.sans,
  },
  form: {
    display: 'flex', flexDirection: 'column', gap: 20,
    padding: 32, borderRadius: radius.lg, background: c.surface,
    border: `1px solid ${c.border}`, width: 360,
    boxShadow: shadow.lg,
  },
  logoWrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    marginBottom: 4,
  },
  title: { margin: 0, color: c.accent, fontSize: 22, fontWeight: 700, letterSpacing: -0.5 },
  subtitle: { margin: 0, color: c.textMuted, fontSize: 13 },
  inputGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 500, color: c.textSecondary },
  input: {
    padding: '9px 12px', borderRadius: radius.md, border: `1px solid ${c.border}`,
    background: c.surface, color: c.text, fontSize: 14, outline: 'none',
    fontFamily: font.sans, transition: 'border-color 0.15s',
  },
  button: {
    padding: '10px 12px', borderRadius: radius.md, border: 'none',
    background: c.accent, color: '#fff', fontSize: 14, cursor: 'pointer',
    fontWeight: 500, fontFamily: font.sans, transition: 'background 0.15s',
    marginTop: 4,
  },
  errorBox: {
    padding: '8px 12px', borderRadius: radius.md,
    background: c.dangerBg, border: `1px solid ${c.danger}20`,
  },
  error: { margin: 0, color: c.danger, fontSize: 13 },
  rememberRow: {
    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
  },
  checkbox: {
    width: 16, height: 16, accentColor: c.accent, cursor: 'pointer', margin: 0,
  },
  rememberLabel: {
    fontSize: 13, color: c.textSecondary, userSelect: 'none' as const,
  },
};
