import { expect, it } from 'vitest';
import { broadRootExposureReason } from './RootManager';

it.each(['/', ' /// ', '/data/', '/home/alice', '/Users/alice/', '~', '~/', '~/.', '~/../..', '~\\..'])('warns before broadly exposing %j', path => {
  expect(broadRootExposureReason(path)).toEqual(expect.any(String));
  expect(broadRootExposureReason(path)?.length).toBeGreaterThan(10);
});
it.each(['', '   ', '/data/project', '/home/alice/project', '/Users/alice/project', '~/project', 'relative/project'])('does not warn for scoped or absent path %j', path => {
  expect(broadRootExposureReason(path)).toBeNull();
});
it('explains the distinct root, home and parent traversal risks', () => {
  expect(broadRootExposureReason('/')).toContain('entire remote machine');
  expect(broadRootExposureReason('/home/alice')).toContain('home');
  expect(broadRootExposureReason('~/../..')).toContain('walks up');
});
