import { isHarnessTicket, protectedPaths } from '../src/engine/protected.ts';
import { projectOf } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';

describe('protectedPaths', () => {
  let e: TestEngine;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
  });

  afterEach(() => e.cleanup());

  // Straight into the store: what the Test Plan applier leaves behind, without a Spec to lock first.
  const plan = async (milestone: number, data: Record<string, unknown>) =>
    e.artifacts.commit(await projectOf(e), {
      message: `milestone ${milestone}: test plan`,
      publish: [{ id: `TEST-PLAN-M${milestone}`, type: 'test_plan', status: 'approved', ownerRole: 'qa_engineer', approvedBy: 'owner:qa_engineer', derivedFrom: [], milestone, body: '# Plan\n', fields: { data } }],
    });

  const pathsFor = async (milestone: number) => protectedPaths(e, await projectOf(e), milestone);

  it("protects every earlier milestone's paths too", async () => {
    await plan(1, { coverage: [], protected: ['acceptance/m1/**'] });
    await plan(2, { coverage: [], protected: ['acceptance/m2/**'] });

    expect(await pathsFor(2)).toEqual([
      { glob: 'acceptance/m1/**', source: 'TEST-PLAN-M1' },
      { glob: 'acceptance/m2/**', source: 'TEST-PLAN-M2' },
    ]);
    expect(await pathsFor(1)).toEqual([{ glob: 'acceptance/m1/**', source: 'TEST-PLAN-M1' }]);
  });

  it('reads the latest version of each plan', async () => {
    await plan(1, { coverage: [], protected: ['old/**'] });
    await plan(1, { coverage: [], protected: ['acceptance/**'] });

    expect(await pathsFor(1)).toEqual([{ glob: 'acceptance/**', source: 'TEST-PLAN-M1' }]);
  });

  it('reads a plan from before plans named protected paths as naming none', async () => {
    await plan(1, { coverage: [] });
    await plan(2, { coverage: [], protected: ['acceptance/m2/**'] });

    expect(await pathsFor(2)).toEqual([{ glob: 'acceptance/m2/**', source: 'TEST-PLAN-M2' }]);
  });

  it('skips a milestone that has no Test Plan yet', async () => {
    await plan(2, { coverage: [], protected: ['acceptance/m2/**'] });

    expect(await pathsFor(1)).toEqual([]);
    expect(await pathsFor(3)).toEqual([{ glob: 'acceptance/m2/**', source: 'TEST-PLAN-M2' }]);
  });
});

describe('isHarnessTicket', () => {
  it('treats only Q tickets as harness tickets', () => {
    expect(isHarnessTicket('M1-Q-2')).toBe(true);
    expect(isHarnessTicket('M1-T-2')).toBe(false);
    expect(isHarnessTicket('M1-B-1')).toBe(false);
  });
});
