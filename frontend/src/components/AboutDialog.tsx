import { useMemo, useState } from 'react';
import { c, radius, shadow, font } from '../theme';
import type { AgentInfo, HealthResponse } from '../api/client';
import { friendlyMessage } from '../api/client';
import { IconBrandMark, IconChevronLeft } from './icons';

interface Props {
  open: boolean;
  health: HealthResponse | null;
  agents: AgentInfo[];
  healthError?: string | null;
  isLikelyDev: boolean;
  onClose: () => void;
}

interface LicenseFile {
  name: string;
  text: string;
}

interface LicensePackage {
  name: string;
  version: string;
  license: string;
  repository: string | null;
  components: string[];
  files: LicenseFile[];
}

interface LicenseManifest {
  project: { name: string; license: string; files: LicenseFile[] };
  packages: LicensePackage[];
  texts: Record<string, string>;
}

let licenseManifestPromise: Promise<LicenseManifest> | null = null;

function loadLicenseManifest(): Promise<LicenseManifest> {
  if (!licenseManifestPromise) {
    licenseManifestPromise = fetch(`${import.meta.env.BASE_URL}third-party-licenses.json`)
      .then((response) => {
        if (!response.ok) throw new Error('License list request failed');
        return response.json() as Promise<LicenseManifest>;
      })
      .catch((error: unknown) => {
        licenseManifestPromise = null;
        throw error;
      });
  }
  return licenseManifestPromise;
}

export function AboutDialog({ open, health, agents, healthError, isLikelyDev, onClose }: Props) {
  const [view, setView] = useState<'main' | 'licenses'>('main');
  const [licenseManifest, setLicenseManifest] = useState<LicenseManifest | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [licenseError, setLicenseError] = useState(false);
  const [licenseQuery, setLicenseQuery] = useState('');
  const [expandedLicenses, setExpandedLicenses] = useState<Set<string>>(() => new Set());

  const requestLicenses = () => {
    setLicenseLoading(true);
    setLicenseError(false);
    void loadLicenseManifest()
      .then(setLicenseManifest)
      .catch(() => setLicenseError(true))
      .finally(() => setLicenseLoading(false));
  };

  const showLicenses = () => {
    setView('licenses');
    if (!licenseManifest) requestLicenses();
  };

  const close = () => {
    setView('main');
    setLicenseQuery('');
    setExpandedLicenses(new Set());
    onClose();
  };

  const visibleLicenses = useMemo(() => {
    if (!licenseManifest) return [];
    const query = licenseQuery.trim().toLowerCase();
    const rows = [
      {
        id: 'filebox',
        name: licenseManifest.project.name,
        version: '',
        license: licenseManifest.project.license,
        repository: null,
        components: [] as string[],
        files: licenseManifest.project.files,
      },
      ...licenseManifest.packages.map((pkg) => ({ id: `${pkg.name}@${pkg.version}`, ...pkg })),
    ];
    return query
      ? rows.filter((row) => row.name.toLowerCase().includes(query) || row.license.toLowerCase().includes(query))
      : rows;
  }, [licenseManifest, licenseQuery]);

  if (!open) return null;

  return (
    <div style={styles.overlay} onClick={close}>
      <div style={view === 'licenses' ? { ...styles.card, ...styles.licensesCard } : styles.card} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.brandRow}>
            <span style={styles.brandMark}><IconBrandMark style={{ width: 18, height: 18 }} /></span>
            <div style={styles.logo}>filebox</div>
          </div>
          <button onClick={close} style={styles.closeBtn} aria-label="Close">×</button>
        </div>
        {view === 'main' ? <div style={styles.body}>
          <div style={styles.row}>
            <span style={styles.label}>Version</span>
            <span style={styles.value}>v{health?.hub.version ?? '—'}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Mode</span>
            <span style={{ ...styles.value, color: isLikelyDev ? c.warning : c.success }}>
              {isLikelyDev ? 'development (local)' : 'production'}
            </span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Homepage</span>
            <a
              href="https://zhimingye.github.io/filebox/"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.link}
            >
              zhimingye.github.io/filebox
            </a>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Licenses</span>
            <button onClick={showLicenses} style={styles.licenseLink}>Open source licenses</button>
          </div>

          <div style={styles.divider} />
          <div style={styles.sectionTitle}>Diagnostics</div>

          {healthError && (
            <div style={styles.errorBanner}>{friendlyMessage({ message: healthError })}</div>
          )}

          {!health ? (
            <div style={styles.loading}>{healthError ? '' : 'Loading...'}</div>
          ) : (
            <>
              <div style={styles.diagCard}>
                <div style={styles.diagCardTitle}>Hub</div>
                <div style={styles.row}>
                  <span style={styles.label}>Status</span>
                  <span style={{ ...styles.value, color: c.success }}>{health.hub.status}</span>
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>Version</span>
                  <span style={styles.value}>{health.hub.version}</span>
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>Uptime</span>
                  <span style={styles.value}>{formatUptime(health.hub.uptime_sec)}</span>
                </div>
              </div>

              {agents.length > 0 && (
                <div style={styles.diagCard}>
                  <div style={styles.diagCardTitle}>Agents</div>
                  <div style={styles.agentList}>
                    {agents.map((a) => {
                      const statusColor = a.status === 'online' ? c.success : a.status === 'slow' ? c.warning : c.textFaint;
                      const statusLabel = a.status === 'online' ? 'Online' : a.status === 'slow' ? 'Slow' : 'Offline';
                      return (
                        <div key={a.id} style={styles.agentEntry}>
                          <div style={styles.agentEntryHeader}>
                            <span style={{ ...styles.agentDot, background: statusColor }} />
                            <span style={styles.agentName}>{a.name}</span>
                            <span style={{ ...styles.agentBadge, color: statusColor, background: `${statusColor}15` }}>
                              {statusLabel}
                            </span>
                          </div>
                          <div style={styles.agentMeta}>
                            <span>RTT: {a.rtt_ms ?? '-'}ms</span>
                            <span>Inflight: {a.inflight}</span>
                            <span>Rev: {a.resource_revision}</span>
                          </div>
                          {a.pending_resource_update && (
                            <div style={styles.pendingRow}>
                              <span style={styles.pendingDot} />
                              <span style={styles.pendingText}>Pending config update</span>
                            </div>
                          )}
                          {a.last_config_error && (
                            <div style={styles.configError}>Config error: {a.last_config_error}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div> : <div style={{ ...styles.body, ...styles.licensesBody }}>
          <div style={styles.licenseHeading}>
            <button onClick={() => setView('main')} style={styles.backBtn} aria-label="Back">
              <IconChevronLeft style={{ width: 14, height: 14 }} />
            </button>
            <span style={styles.licenseTitle}>Open source licenses</span>
          </div>
          {licenseManifest && (
            <div style={styles.licenseSummary}>
              filebox is licensed under Apache-2.0 and includes {licenseManifest.packages.length} third-party packages.
            </div>
          )}
          <input
            type="search"
            aria-label="Filter licenses"
            placeholder="Filter by name or license…"
            value={licenseQuery}
            onChange={(event) => setLicenseQuery(event.target.value)}
            style={styles.licenseSearch}
          />
          {licenseLoading && <div style={styles.loading}>Loading licenses...</div>}
          {licenseError && (
            <div style={styles.errorBanner}>
              Could not load the license list.{' '}
              <button onClick={requestLicenses} style={styles.errorRetry}>Retry</button>
            </div>
          )}
          {licenseManifest && (
            <div style={styles.licenseList}>
              {visibleLicenses.length === 0 ? <div style={styles.loading}>No matching packages.</div> : visibleLicenses.map((row) => {
                const isExpanded = expandedLicenses.has(row.id);
                const components = ['hub', 'agent', 'frontend']
                  .filter((component) => row.components.includes(component))
                  .map((component) => component === 'hub' ? 'Hub' : component === 'agent' ? 'Agent' : 'Frontend')
                  .join(' · ');
                return (
                  <div key={row.id} style={styles.licenseEntry}>
                    <button
                      onClick={() => setExpandedLicenses((current) => {
                        const next = new Set(current);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })}
                      style={styles.licenseEntryButton}
                      aria-expanded={isExpanded}
                    >
                      <span style={styles.licensePackageName}>
                        <span>{row.name}</span>
                        {row.version && <span style={styles.licenseVersion}>{row.version}</span>}
                      </span>
                      <span style={styles.licenseName}>{row.license}</span>
                    </button>
                    {isExpanded && (
                      <div style={styles.licenseDetails}>
                        {(components || row.repository) && (
                          <div style={styles.licenseMeta}>
                            {components && <span>{components}</span>}
                            {row.repository && (
                              <a href={row.repository} target="_blank" rel="noopener noreferrer" style={styles.repositoryLink}>
                                Repository
                              </a>
                            )}
                          </div>
                        )}
                        {row.files.length > 0 ? row.files.map((file) => (
                          <div key={`${row.id}:${file.name}`} style={styles.licenseFile}>
                            <div style={styles.diagCardTitle}>{file.name}</div>
                            <pre style={styles.licenseText}>{licenseManifest.texts[file.text] ?? ''}</pre>
                          </div>
                        )) : (
                          <div style={styles.noLicenseFile}>
                            No license file is shipped with this package; declared license: {row.license}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>}
        <button onClick={close} style={styles.doneBtn}>Done</button>
      </div>
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 2000,
    background: c.bgOverlay,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  card: {
    width: '100%', maxWidth: 380,
    background: c.surface, borderRadius: radius.lg,
    border: `1px solid ${c.border}`, boxShadow: shadow.lg,
    overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  licensesCard: {
    maxWidth: 560, maxHeight: 'calc(100dvh - 32px)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 18px', borderBottom: `1px solid ${c.border}`,
    background: c.bgSubtle, flexShrink: 0,
  },
  brandRow: {
    display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
  },
  brandMark: {
    color: c.accent, display: 'flex', flexShrink: 0,
  },
  logo: {
    fontSize: 15, fontWeight: 600, color: c.text, fontFamily: font.sans,
    letterSpacing: '-0.02em',
  },
  closeBtn: {
    background: 'none', border: 'none', fontSize: 22, lineHeight: 1,
    color: c.textMuted, cursor: 'pointer', padding: '0 4px', borderRadius: radius.sm,
    transition: 'color 0.15s',
  },
  body: {
    padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  label: {
    fontSize: 12, color: c.textMuted, fontWeight: 500,
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  value: {
    fontSize: 13, color: c.text, fontFamily: font.mono, fontWeight: 600,
  },
  link: {
    fontSize: 13, color: c.accent, textDecoration: 'none', fontWeight: 500,
  },
  licenseLink: {
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    fontSize: 13, color: c.accent, fontWeight: 500, fontFamily: font.sans,
  },
  licensesBody: {
    flex: 1, minHeight: 0, overflowY: 'auto',
  },
  licenseHeading: { display: 'flex', alignItems: 'center', gap: 5 },
  backBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', color: c.textMuted, cursor: 'pointer',
    padding: '2px 3px', borderRadius: radius.sm,
  },
  licenseTitle: { color: c.text, fontSize: 13, fontWeight: 600 },
  licenseSummary: { color: c.textMuted, fontSize: 12, lineHeight: 1.45 },
  licenseSearch: {
    width: '100%', boxSizing: 'border-box', padding: '7px 9px',
    borderWidth: 1, borderStyle: 'solid', borderColor: c.border,
    borderRadius: radius.md, background: c.surface, color: c.text,
    fontSize: 12.5, fontFamily: font.sans,
  },
  licenseList: { display: 'flex', flexDirection: 'column' },
  licenseEntry: {
    borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: c.borderSubtle,
  },
  licenseEntryButton: {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, background: 'none', border: 'none', padding: '9px 2px',
    color: c.text, cursor: 'pointer', textAlign: 'left',
  },
  licensePackageName: {
    display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0,
    fontFamily: font.mono, fontSize: 13, overflow: 'hidden',
  },
  licenseVersion: { color: c.textFaint, fontFamily: font.sans, fontSize: 12, flexShrink: 0 },
  licenseName: {
    maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: c.textMuted, fontSize: 12, flexShrink: 0,
  },
  licenseDetails: { padding: '0 2px 11px' },
  licenseMeta: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
    margin: '0 0 10px', color: c.textMuted, fontSize: 12,
  },
  repositoryLink: { color: c.accent, textDecoration: 'none' },
  licenseFile: { marginTop: 8 },
  licenseText: {
    maxHeight: 240, overflow: 'auto', margin: '5px 0 0', padding: '10px 12px',
    background: c.bgSubtle, borderWidth: 1, borderStyle: 'solid', borderColor: c.border,
    borderRadius: radius.md, color: c.text, fontFamily: font.mono,
    fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  noLicenseFile: { color: c.textMuted, fontSize: 12, lineHeight: 1.5 },
  errorRetry: {
    background: 'none', border: 'none', padding: 0, color: c.danger,
    fontSize: 12, textDecoration: 'underline', cursor: 'pointer',
  },
  divider: { height: 1, background: c.border, margin: '4px 0' },
  sectionTitle: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.8, fontWeight: 600,
  },
  errorBanner: {
    background: c.dangerBg, border: `1px solid ${c.danger}20`, borderRadius: radius.md,
    padding: '10px 14px', color: c.danger, fontSize: 13,
  },
  loading: { color: c.textMuted, fontSize: 13, padding: '4px 0' },
  diagCard: {
    background: c.bgSubtle, border: `1px solid ${c.border}`, borderRadius: radius.md,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
  },
  diagCardTitle: {
    fontSize: 11, textTransform: 'uppercase', color: c.textMuted,
    letterSpacing: 0.5, fontWeight: 500,
  },
  agentList: { display: 'flex', flexDirection: 'column' },
  agentEntry: { padding: '10px 0', borderTop: `1px solid ${c.borderSubtle}` },
  agentEntryHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  agentDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  agentName: { color: c.text, fontSize: 13, fontWeight: 500, flex: 1 },
  agentBadge: {
    fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: radius.pill,
  },
  agentMeta: { display: 'flex', gap: 16, fontSize: 12, color: c.textMuted, marginTop: 6 },
  pendingRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 },
  pendingDot: { width: 6, height: 6, borderRadius: '50%', background: c.warning },
  pendingText: { color: c.warning, fontSize: 12 },
  configError: { color: c.danger, fontSize: 12, marginTop: 6 },
  doneBtn: {
    margin: '4px 18px 18px',
    padding: '9px 16px', borderRadius: radius.md, border: 'none',
    background: c.accent, color: '#fff', cursor: 'pointer', fontSize: 13,
    fontWeight: 600, transition: 'background 0.15s', flexShrink: 0,
  },
};
