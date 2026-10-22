import { UpdateSpellUsableEvent } from 'parser/core/Events';

import { Profile } from '../profile/types';
import { cooldownUsage } from './CooldownMetrics';
import { contains, mergeIntervals, totalDuration, windowThroughput } from './intervals';
import { scoreProfile, statusFor } from './results';

describe('intervals', () => {
  it('merges overlapping intervals and clamps to bounds', () => {
    const merged = mergeIntervals(
      [
        { start: 50, end: 120 },
        { start: 0, end: 60 },
        { start: 200, end: 400 },
      ],
      10,
      300,
    );
    expect(merged).toEqual([
      { start: 10, end: 120 },
      { start: 200, end: 300 },
    ]);
    expect(totalDuration(merged)).toBe(210);
    expect(contains(merged, 119)).toBe(true);
    expect(contains(merged, 120)).toBe(false);
  });

  it('computes in-window DPS relative to out-of-window DPS', () => {
    const damage = [
      { timestamp: 5, amount: 100 },
      { timestamp: 15, amount: 300 },
      { timestamp: 25, amount: 100 },
    ];
    // 10ms window with 300 damage vs 20ms outside with 200 damage: 30/ms vs 10/ms.
    const result = windowThroughput(damage, [{ start: 10, end: 20 }], 0, 30);
    expect(result.ratio).toBeCloseTo(3);
  });
});

describe('cooldownUsage', () => {
  const update = (timestamp: number, isOnCooldown: boolean) =>
    ({ timestamp, isOnCooldown, expectedRechargeDuration: 30_000 }) as UpdateSpellUsableEvent;

  it('counts idle time from pull and between cooldowns as lost casts', () => {
    // Ready at 0, cast at 10s; ready again at 40s, cast at 100s; ready at 130s until 200s.
    const usage = cooldownUsage(
      2,
      [update(10_000, true), update(40_000, false), update(100_000, true), update(130_000, false)],
      0,
      200_000,
    );
    expect(usage).toEqual({ casts: 2, idleMs: 140_000, cooldownMs: 30_000, lostCasts: 4 });
  });

  it('returns null without cooldown history', () => {
    expect(cooldownUsage(0, [], 0, 1000)).toBeNull();
  });
});

describe('scoreProfile', () => {
  const profile: Profile = {
    id: 'p',
    name: 'p',
    specId: 1,
    version: 2,
    entries: [
      {
        spellId: 2,
        kind: 'buff',
        rank: 2,
        metrics: ['uptime'],
        thresholds: { uptime: { pass: 0.9, warn: 0.8 } },
      },
      { spellId: 1, kind: 'debuff', rank: 1, metrics: ['uptime'] },
    ],
    rules: [
      {
        id: 'r',
        description: 'r',
        rank: 1,
        onCast: [3],
        require: [],
        thresholds: { pass: 1, warn: 0.5 },
      },
    ],
  };

  it('orders by rank and applies thresholds', () => {
    const results = scoreProfile(
      profile,
      [
        {
          spellId: 2,
          kind: 'buff',
          applicable: true,
          metrics: { uptime: { value: 0.85, detail: {} } },
        },
        {
          spellId: 1,
          kind: 'debuff',
          applicable: true,
          metrics: { uptime: { value: 0.5, detail: {} } },
        },
      ],
      [{ ruleId: 'r', casts: 4, passed: 3 }],
    );
    expect(results.entries.map((e) => e.spellId)).toEqual([1, 2]);
    expect(results.entries[0].metrics.uptime?.status).toBe('unknown');
    expect(results.entries[1].metrics.uptime?.status).toBe('warn');
    expect(results.rules[0]).toMatchObject({ value: 0.75, status: 'warn' });
  });

  it('treats missing values as unknown', () => {
    expect(statusFor(null, { pass: 1, warn: 0 })).toBe('unknown');
  });
});
