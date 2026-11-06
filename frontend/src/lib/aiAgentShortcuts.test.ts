import { expect, it } from 'vitest';
import { shortcutProfile } from './aiAgentShortcuts';

it.each([['PI-agent', 'pi'], ['pi_agent', 'pi'], ['Pi agent', 'pi'], ['pixel', 'common'], ['pipeline', 'common'], ['PIANO', 'common'], ['CLAUDE-CODE', 'claude'], ['OpenAI-CODEX', 'codex'], [null, 'common'], [undefined, 'common'], ['', 'common']])('resolves profile boundary %j', (kind, expected) => expect(shortcutProfile(kind)).toBe(expected));
