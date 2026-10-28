import type { AgentInfo } from '../api/client';
import { HerdrButton } from './HerdrControls';
import { c, font, radius, shadow } from '../theme';

export function HerdrIntro({ agent, onOpenSettings }: { agent: AgentInfo; onOpenSettings: () => void }) {
  const disabled = agent.capabilities?.herdr_settings && !agent.capabilities.herdr_enabled;
  return <div style={{ height: '100%', overflow: 'auto', background: c.bgSubtle, fontFamily: font.sans }}>
    <section aria-labelledby="herdr-intro-title" style={{ maxWidth: 620, margin: '0 auto', padding: '32px 24px', color: c.text }}>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: c.textMuted }}>Coding agents · {agent.name}</p>
      <h1 id="herdr-intro-title" style={{ margin: '0 0 12px', fontSize: 24, fontWeight: 600 }}>
        {disabled ? 'Herdr is turned off' : 'Meet Herdr'}
      </h1>
      <p style={{ color: c.textSecondary, fontSize: 14, lineHeight: 1.7 }}>
        Herdr is a separate tool for running and managing coding agents on your machine.
        Connect it to Filebox to see which agents need attention, read their terminal output,
        and send prompts or approval keys from your browser — including your phone.
      </p>
      <div style={{ padding: 20, margin: '24px 0', border: `1px solid ${c.border}`, borderRadius: radius.lg,
        background: c.surface, boxShadow: shadow.xs, fontSize: 13, lineHeight: 1.7 }}>
        {disabled ? <>
          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Disabled for this backend</h2>
          <p style={{ margin: 0, color: c.textSecondary }}>Filebox will not check Herdr or send it commands.
            This does not stop Herdr or any coding agents already running on the machine.
            You can turn the integration back on in Agent settings.</p>
        </> : <>
          <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Set up Herdr on {agent.name}</h2>
          <p style={{ margin: '0 0 12px', color: c.textSecondary }}>Filebox has not detected an available Herdr CLI on this backend.
            If you have not installed it yet:</p>
          <ol style={{ margin: 0, paddingLeft: 20, color: c.textSecondary }}>
            <li style={{ marginBottom: 10 }}>Follow the <a href="https://github.com/herdrdev/herdr" target="_blank" rel="noopener noreferrer"
              style={{ color: c.accent }}>Herdr installation guide</a> on that machine, using the same OS user as the Filebox Agent.</li>
            <li style={{ marginBottom: 10 }}>Make <code>herdr</code> available on the Agent’s <code>PATH</code>, or set <code>FILEBOX_AGENT_HERDR</code> to its executable path.</li>
            <li style={{ marginBottom: 10 }}>Start <code>herdr</code> or <code>herdr server</code> there, then launch a coding agent through Herdr.</li>
            <li>Restart the Filebox Agent to detect the CLI and any environment changes.
              {agent.capabilities?.herdr_settings && !agent.capabilities.herdr_locked && ' If only the CLI installation changed, you can instead turn this integration off and on in Agent settings to check again.'}</li>
          </ol>
        </>}
      </div>
      <p style={{ fontSize: 12, lineHeight: 1.6, color: c.textSecondary }}>
        Optional: file browsing and system monitoring work without Herdr. Filebox only uses the local CLI on this backend; it does not install Herdr for you.
      </p>
      <HerdrButton touch onClick={onOpenSettings} style={{ borderColor: c.border, background: c.surface }}>
        {disabled ? 'Open Agent settings' : 'Manage Herdr in Agent settings'}
      </HerdrButton>
      {agent.status === 'offline' && <p role="status" style={{ color: c.textMuted, fontSize: 12 }}>This backend is offline. Reconnect it before changing settings.</p>}
    </section>
  </div>;
}
