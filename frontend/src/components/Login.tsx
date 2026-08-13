import { useCallback, useEffect, useRef, useState } from 'react';
import { c, radius, shadow, font } from '../theme';
import { IconBrandMark, IconCheck, IconRefresh } from './icons';
import { useIsMobile } from '../state/useIsMobile';
import { getPowChallenge, type ApiError } from '../api/client';
import { solvePow } from '../lib/pow';

interface Props {
  onLogin: (
    username: string,
    password: string,
    remember: boolean,
    powId: string,
    powNonce: string,
  ) => Promise<boolean>;
}

type VerificationStatus = 'loading' | 'solving' | 'ready' | 'error';

export function Login({ onLogin }: Props) {
  const isMobile = useIsMobile();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<'user' | 'pass' | null>(null);
  const [btnHover, setBtnHover] = useState(false);
  const [pow, setPow] = useState<{ id: string; salt: string; difficulty: number } | null>(null);
  const [powNonce, setPowNonce] = useState<string | null>(null);
  const [powStatus, setPowStatus] = useState<VerificationStatus>('loading');
  const [powProgress, setPowProgress] = useState(0);
  const [powErrorMsg, setPowErrorMsg] = useState<string | null>(null);
  // Supersedes stale fetches/solves (a new run invalidates the previous one).
  const powGenRef = useRef(0);
  const powAbortRef = useRef<AbortController | null>(null);
  // Synchronous guard so a double-click / Enter+click cannot fire two
  // exchangeSession calls with the same (single-use) challenge.
  const submitLockRef = useRef(false);

  const canSubmit =
    username.trim().length > 0
    && password.trim().length > 0
    && powStatus === 'ready'
    && powNonce !== null
    && !loading;

  // Fetch a challenge and solve it in the background. Event handlers and the
  // deferred mount effect may call this; it sets state synchronously, so the
  // mount effect defers it one tick (react-hooks/set-state-in-effect).
  const startVerification = useCallback(async () => {
    const gen = ++powGenRef.current;
    powAbortRef.current?.abort();
    const controller = new AbortController();
    powAbortRef.current = controller;
    setPow(null);
    setPowNonce(null);
    setPowStatus('loading');
    setPowProgress(0);
    setPowErrorMsg(null);

    let challenge;
    try {
      challenge = await getPowChallenge(controller.signal);
    } catch (err) {
      if (powGenRef.current !== gen) return;
      setPowStatus('error');
      // Surface rate-limit feedback instead of a bare "Unavailable".
      const apiError = err as ApiError;
      if (apiError?.error === 'pow_rate_limited' && apiError?.message) {
        setPowErrorMsg(apiError.message);
      }
      return;
    }
    if (powGenRef.current !== gen || controller.signal.aborted) return;

    setPow({ id: challenge.id, salt: challenge.salt, difficulty: challenge.difficulty });
    setPowStatus('solving');
    const expected = Math.pow(2, challenge.difficulty);
    let lastRender = 0;
    try {
      const nonce = await solvePow(challenge, {
        signal: controller.signal,
        onProgress: (attempts) => {
          // Throttle to ~4 renders/s — the solver reports per ~16k hashes,
          // and this text feeds an aria-live region (keep announcements
          // sparse for screen readers).
          const now = Date.now();
          if (now - lastRender < 250) return;
          lastRender = now;
          if (powGenRef.current === gen) {
            setPowProgress(Math.min(99, Math.round((attempts / expected) * 100)));
          }
        },
      });
      if (powGenRef.current !== gen || controller.signal.aborted) return;
      setPowNonce(nonce);
      setPowStatus('ready');
    } catch (err) {
      if (powGenRef.current !== gen) return;
      if ((err as DOMException)?.name === 'AbortError') return;
      setPowStatus('error');
    }
  }, []);

  useEffect(() => {
    // Deferred one tick so no state update fires synchronously from the
    // effect; the cleanup aborts any in-flight verification on unmount.
    const timer = window.setTimeout(() => void startVerification(), 0);
    return () => {
      window.clearTimeout(timer);
      powGenRef.current += 1;
      powAbortRef.current?.abort();
    };
  }, [startVerification]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitLockRef.current) return;
    if (!canSubmit || !pow || !powNonce) return;
    submitLockRef.current = true;
    setLoading(true);
    setError('');
    try {
      const ok = await onLogin(username, password, remember, pow.id, powNonce);
      if (!ok) {
        setError('Invalid username or password');
        void startVerification();
      }
    } catch (err) {
      const apiError = err as ApiError;
      switch (apiError?.error) {
        case 'invalid_credentials':
          setError('Invalid username or password');
          break;
        case 'pow_failed':
          setError(apiError?.message || 'Verification failed');
          break;
        case 'login_rate_limited':
          setError(apiError?.message || 'Too many login attempts. Try again shortly.');
          break;
        default:
          setError('Authentication failed. Check the hub is reachable.');
          break;
      }
      // A consumed challenge can never be retried; the rate-limit pause is
      // the one failure where the current challenge is not the problem.
      if (apiError?.error !== 'login_rate_limited') {
        void startVerification();
      }
    } finally {
      setLoading(false);
      submitLockRef.current = false;
    }
  };

  return (
    <div style={styles.page}>
      {/* Quiet brand watermark — commercial product chrome, not a marketing hero. */}
      <div style={styles.pageGlow} aria-hidden />

      <div style={{ ...styles.shell, ...(isMobile ? styles.shellMobile : null) }}>
        <form
          onSubmit={handleSubmit}
          style={{ ...styles.card, ...(isMobile ? styles.cardMobile : null) }}
          noValidate
        >
          <header style={styles.header}>
            <div style={styles.brandRow}>
              <span style={styles.brandMark}>
                <IconBrandMark style={{ width: 22, height: 22 }} />
              </span>
              <span style={styles.brandName}>filebox</span>
            </div>
            <div style={styles.headerCopy}>
              <h1 style={styles.heading}>Sign in</h1>
            </div>
          </header>

          <div style={styles.fields}>
            <div style={styles.field}>
              <label htmlFor="fb-username" style={styles.label}>Username</label>
              <input
                id="fb-username"
                type="text"
                value={username}
                onChange={(e) => { setUsername(e.target.value); if (error) setError(''); }}
                onFocus={() => setFocused('user')}
                onBlur={() => setFocused(null)}
                style={{
                  ...styles.input,
                  ...(focused === 'user' ? styles.inputFocus : null),
                  ...(error ? styles.inputError : null),
                }}
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={loading}
              />
            </div>

            <div style={styles.field}>
              <label htmlFor="fb-password" style={styles.label}>Password</label>
              <div style={styles.passwordWrap}>
                <input
                  id="fb-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
                  onFocus={() => setFocused('pass')}
                  onBlur={() => setFocused(null)}
                  placeholder="••••••••"
                  style={{
                    ...styles.input,
                    ...styles.passwordInput,
                    ...(focused === 'pass' ? styles.inputFocus : null),
                    ...(error ? styles.inputError : null),
                  }}
                  autoComplete="current-password"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  style={styles.revealBtn}
                  tabIndex={-1}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div style={styles.field}>
              <label htmlFor="fb-pow" style={styles.label}>Verification</label>
              <div style={styles.powBadge} aria-live="polite">
                <span style={styles.powBadgeText}>
                  {powStatus === 'solving' && `Solving… ${powProgress}%`}
                  {powStatus === 'ready' && 'Ready'}
                  {powStatus === 'error' && 'Unavailable'}
                  {powStatus === 'loading' && '…'}
                </span>
                {powStatus === 'ready' && (
                  <IconCheck style={{ width: 14, height: 14, color: c.success }} />
                )}
                <button
                  type="button"
                  onClick={() => void startVerification()}
                  style={styles.powRefresh}
                  disabled={powStatus === 'loading' || powStatus === 'solving' || loading}
                  title="Re-run verification"
                  aria-label="Re-run verification"
                >
                  <IconRefresh style={{ width: 14, height: 14 }} />
                </button>
              </div>
              <div style={styles.powHint}>
                {powStatus === 'solving'
                  ? 'Proving this is not an automated sign-in attempt…'
                  : 'Protects the sign-in form from automated attempts.'}
              </div>
              {powStatus === 'error' && (
                <div style={styles.powErrorText}>
                  {powErrorMsg ?? 'Could not complete verification.'}
                  <button
                    type="button"
                    onClick={() => void startVerification()}
                    style={styles.powRetry}
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>

            <label style={styles.rememberRow}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                style={styles.checkbox}
                disabled={loading}
              />
              <span style={styles.rememberLabel}>
                Keep me signed in
                <span style={styles.rememberHint}>30 days</span>
              </span>
            </label>

            {error && (
              <div style={styles.errorBox} role="alert">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              onMouseEnter={() => setBtnHover(true)}
              onMouseLeave={() => setBtnHover(false)}
              style={{
                ...styles.submit,
                ...(canSubmit && btnHover ? styles.submitHover : null),
                ...(!canSubmit ? styles.submitDisabled : null),
              }}
            >
              {loading ? 'Signing in…' : 'Continue'}
            </button>
          </div>
        </form>

        <p style={styles.footerNote}>
          Read-only remote file browser
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100%',
    padding: 24,
    boxSizing: 'border-box',
    background: c.bgSubtle,
    fontFamily: font.sans,
    overflow: 'hidden',
  },
  // Soft accent wash behind the card — restrained, not a gradient hero.
  pageGlow: {
    position: 'absolute',
    top: '18%',
    left: '50%',
    width: 480,
    height: 320,
    transform: 'translateX(-50%)',
    background: `radial-gradient(ellipse at center, ${c.accentBg} 0%, transparent 70%)`,
    pointerEvents: 'none',
    opacity: 0.85,
  },
  shell: {
    position: 'relative',
    width: '100%',
    maxWidth: 400,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 16,
    zIndex: 1,
  },
  shellMobile: {
    maxWidth: 400,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 28,
    padding: '32px 32px 28px',
    borderRadius: radius.lg,
    background: c.surface,
    border: `1px solid ${c.border}`,
    boxShadow: shadow.md,
    boxSizing: 'border-box',
  },
  cardMobile: {
    padding: '28px 22px 24px',
    gap: 24,
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  brandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
  },
  brandMark: {
    color: c.accent,
    display: 'flex',
    flexShrink: 0,
  },
  brandName: {
    fontSize: 14,
    fontWeight: 600,
    color: c.text,
    letterSpacing: '-0.02em',
  },
  headerCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  heading: {
    margin: 0,
    fontSize: 22,
    fontWeight: 600,
    color: c.text,
    letterSpacing: '-0.03em',
    lineHeight: 1.15,
  },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 12.5,
    fontWeight: 500,
    color: c.textSecondary,
    letterSpacing: '-0.01em',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: c.surface,
    color: c.text,
    fontSize: 14,
    outline: 'none',
    fontFamily: font.sans,
    boxSizing: 'border-box',
    transition: 'border-color 0.12s, box-shadow 0.12s',
    lineHeight: 1.35,
  },
  inputFocus: {
    borderColor: c.accent,
    boxShadow: `0 0 0 3px ${c.accentBg}`,
  },
  inputError: {
    borderColor: `${c.danger}99`,
  },
  passwordWrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  passwordInput: {
    paddingRight: 56,
  },
  revealBtn: {
    position: 'absolute',
    right: 6,
    top: '50%',
    transform: 'translateY(-50%)',
    border: 'none',
    background: 'transparent',
    color: c.textMuted,
    fontSize: 12,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: radius.sm,
    lineHeight: 1,
  },
  // Proof-of-work status badge — striped "checking" affordance using theme
  // tokens only (no external images).
  powBadge: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 40,
    padding: '0 6px 0 12px',
    borderRadius: radius.md,
    border: `1px solid ${c.border}`,
    background: `repeating-linear-gradient(-45deg, ${c.bgMuted} 0px, ${c.bgMuted} 6px, ${c.surface} 6px, ${c.surface} 12px)`,
    boxSizing: 'border-box',
  },
  powBadgeText: {
    flex: 1,
    fontFamily: font.mono,
    fontSize: 13.5,
    fontWeight: 600,
    color: c.textSecondary,
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
    userSelect: 'none' as const,
  },
  powRefresh: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    border: 'none',
    background: 'transparent',
    color: c.textMuted,
    cursor: 'pointer',
    borderRadius: radius.sm,
    padding: 0,
    flexShrink: 0,
  },
  powHint: {
    fontSize: 12,
    color: c.textMuted,
    lineHeight: 1.4,
    letterSpacing: '-0.01em',
  },
  powErrorText: {
    fontSize: 12.5,
    color: c.danger,
    lineHeight: 1.4,
  },
  powRetry: {
    border: 'none',
    background: 'transparent',
    color: c.accent,
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: font.sans,
    cursor: 'pointer',
    padding: 0,
    marginLeft: 6,
    textDecoration: 'underline',
  },
  rememberRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    userSelect: 'none' as const,
    marginTop: 2,
  },
  checkbox: {
    width: 15,
    height: 15,
    accentColor: c.accent,
    cursor: 'pointer',
    margin: 0,
    flexShrink: 0,
  },
  rememberLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: c.textSecondary,
  },
  rememberHint: {
    fontSize: 11.5,
    color: c.textMuted,
    fontFamily: font.mono,
    letterSpacing: '-0.02em',
  },
  errorBox: {
    padding: '9px 12px',
    borderRadius: radius.md,
    background: c.dangerBg,
    border: `1px solid ${c.danger}22`,
    color: c.danger,
    fontSize: 13,
    lineHeight: 1.4,
  },
  submit: {
    marginTop: 4,
    width: '100%',
    height: 40,
    padding: '0 14px',
    borderRadius: radius.md,
    border: 'none',
    background: c.accent,
    color: c.onAccent,
    fontSize: 14,
    fontWeight: 600,
    fontFamily: font.sans,
    cursor: 'pointer',
    letterSpacing: '-0.01em',
    transition: 'background 0.12s, opacity 0.12s',
    // Override global button:hover { opacity: 0.9 } wash.
    opacity: 1,
  },
  submitHover: {
    background: c.accentHover,
    opacity: 1,
  },
  submitDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  footerNote: {
    margin: 0,
    textAlign: 'center',
    fontSize: 12,
    color: c.textMuted,
    letterSpacing: '-0.01em',
  },
};
