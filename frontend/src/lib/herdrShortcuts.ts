export type Profile = 'common' | 'pi' | 'claude' | 'codex';
interface Shortcut { label: string; keys: string[]; description: string }
const key = (label: string, value: string, description: string): Shortcut => ({ label, keys: [value], description });
export const QUICK_KEYS: Shortcut[] = [
  key('Enter', 'enter', 'Confirm or submit remote input'),
  key('Esc', 'esc', 'Cancel a dialog or interrupt the current turn'),
  key('Ctrl+C', 'ctrl+c', 'Interrupt or clear input; repeated presses may exit'),
  key('Tab', 'tab', 'Complete, select, or queue remote input'),
  key('Y', 'y', 'Choose yes in an approval prompt'),
  key('N', 'n', 'Choose no in an approval prompt'),
  key('Up', 'up', 'Previous option or prompt'), key('Down', 'down', 'Next option or prompt'),
  key('Left', 'left', 'Move left'), key('Right', 'right', 'Move right'),
  key('Shift+Tab', 'shift+tab', 'Pi: thinking level; Claude: permission mode/session approval; Codex: collaboration mode'),
  key('Ctrl+End', 'ctrl+end', 'Remote transcript bottom (requires Herdr navigation-key support)'),
];
const COMMON: Shortcut[] = [
  ...['1', '2', '3', '4', '5'].map((n) => key(n, n, `Choose numbered option ${n}`)),
  key('Space', 'space', 'Toggle focused option'),
  key('PageUp', 'pageup', 'Previous screen'), key('PageDown', 'pagedown', 'Next screen'),
  key('Ctrl+Home', 'ctrl+home', 'Transcript beginning'), key('Ctrl+End', 'ctrl+end', 'Transcript end'),
  key('Home', 'home', 'Line start / pager top'), key('End', 'end', 'Line end / pager bottom'),
  key('Backspace', 'backspace', 'Erase previous character'), key('Delete', 'delete', 'Erase next character'),
  key('Ctrl+A', 'ctrl+a', 'Line start (approval dialogs may use a different action)'),
  key('Ctrl+E', 'ctrl+e', 'Line end (Claude classic transcript: expand content)'),
  key('Ctrl+U', 'ctrl+u', 'Erase to line start'), key('Ctrl+K', 'ctrl+k', 'Erase to line end'),
  key('Ctrl+W', 'ctrl+w', 'Erase previous word'), key('Ctrl+Y', 'ctrl+y', 'Restore deleted input'),
  key('Alt+B', 'alt+b', 'Previous word'), key('Alt+F', 'alt+f', 'Next word'),
  key('Ctrl+J', 'ctrl+j', 'Newline in remote input'),
  key('Ctrl+G', 'ctrl+g', 'Open the remote external editor'),
  key('Ctrl+D', 'ctrl+d', 'May exit the agent; otherwise delete in input'),
  key('Ctrl+Z', 'ctrl+z', 'Suspend to the remote shell on Unix; resume there with fg'),
];
// Defaults verified against official docs/source on 2026-10-15. See docs/herdr-shortcuts.md.
export const PROFILE_KEYS: Record<Profile, Shortcut[]> = {
  common: [],
  pi: [
    key('Ctrl+L', 'ctrl+l', 'Choose model'), key('Ctrl+P', 'ctrl+p', 'Next model'),
    key('Ctrl+Shift+P', 'ctrl+shift+p', 'Previous model (Unix default)'),
    key('Ctrl+O', 'ctrl+o', 'Expand tool results'), key('Ctrl+T', 'ctrl+t', 'Expand thinking'),
    key('Alt+Enter', 'alt+enter', 'Queue remote draft as follow-up'),
    key('Alt+Up', 'alt+up', 'Take queued messages back into remote input'),
    key('Ctrl+Shift+F', 'ctrl+shift+f', 'Search fullscreen transcript'),
  ],
  claude: [
    key('Ctrl+O', 'ctrl+o', 'Open transcript'), key('Ctrl+T', 'ctrl+t', 'Show task checklist'),
    key('Ctrl+B', 'ctrl+b', 'Background the running task'), key('Ctrl+R', 'ctrl+r', 'Find prior prompts'),
    key('Ctrl+S', 'ctrl+s', 'Stash / restore draft'), key('Ctrl+L', 'ctrl+l', 'Redraw display'),
    key('Alt+P', 'alt+p', 'Choose model'), key('Alt+T', 'alt+t', 'Toggle thinking on models that support it'),
    { label: 'Esc Esc', keys: ['esc', 'esc'], description: 'Clear draft / open rewind menu when input is empty' },
    { label: 'Ctrl+X Ctrl+S', keys: ['ctrl+x', 'ctrl+s'], description: 'Send queued messages now (recent Claude versions)' },
  ],
  codex: [
    key('Ctrl+T', 'ctrl+t', 'Open transcript pager'), key('Ctrl+L', 'ctrl+l', 'Redraw display'),
    key('Ctrl+R', 'ctrl+r', 'Find older prompt'), key('Ctrl+S', 'ctrl+s', 'Next history-search match'),
    key('F3', 'f3', 'Search transcript (recent versions)'),
    key('Shift+Up', 'shift+up', 'Increase reasoning effort'), key('Shift+Down', 'shift+down', 'Decrease reasoning effort'),
    key('Alt+Up', 'alt+up', 'Edit queued message'), key('Alt+Down', 'alt+down', 'Return through prompt stack'),
  ],
};
export const COMMON_KEYS = COMMON;
export function shortcutProfile(kind?: string | null): Profile {
  const normalized = kind?.toLowerCase() ?? '';
  if (normalized.includes('claude')) return 'claude';
  if (normalized.includes('codex')) return 'codex';
  if (/^pi(?:$|[-_ ])/.test(normalized)) return 'pi';
  return 'common';
}
