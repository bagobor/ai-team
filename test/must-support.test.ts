import { gateStatuses, mustSupportProblems, playRuns, renderMustSupport, type MsItem } from '../src/engine/must-support.ts';

const phone: MsItem = {
  id: 'MS-1',
  group: 'runs_on',
  text: 'Plays in a phone browser held upright, by touch',
  brief_quote: 'it must work on my phone',
  check: 'play',
  viewport: 'phone_portrait',
  input: 'touch',
  fits_screen: true,
};
const cmd: MsItem = { id: 'MS-2', group: 'built_with', text: 'Plain JavaScript, no build step', brief_quote: 'no build step', check: 'command' };
const you: MsItem = { id: 'MS-3', group: 'runs_on', text: 'Touch feels good on a real phone', brief_quote: 'feels good on my phone', check: 'human', how: 'Play it on your phone' };

describe('mustSupportProblems', () => {
  it('refuses an empty list', () => {
    expect(mustSupportProblems([], { current: [], used: [] })).toEqual(['The list is empty: name at least what the brief says the game runs on']);
  });

  it('keeps a current id and refuses a removed one coming back', () => {
    expect(mustSupportProblems([phone], { current: ['MS-1'], used: ['MS-1', 'MS-2'] })).toEqual([]);
    expect(mustSupportProblems([phone, cmd], { current: ['MS-1'], used: ['MS-1', 'MS-2'] })).toContain('MS-2 is new, so its id must be above MS-2, the highest used so far');
  });

  it('needs a viewport and an input on a play item, and a how on a human one', () => {
    const p = mustSupportProblems([{ ...phone, viewport: undefined, input: undefined }, { ...you, how: ' ' }], { current: [], used: [] });
    expect(p).toEqual(
      expect.arrayContaining(['MS-1 is checked by play and needs a viewport', 'MS-1 is checked by play and needs an input: keys, touch, mouse or null', 'MS-3 is checked by you and needs a how']),
    );
  });

  it('needs a brief quote unless the item is proposed with a reason', () => {
    expect(mustSupportProblems([{ ...phone, brief_quote: '' }], { current: [], used: [] })).toContain('MS-1 quotes nothing from the brief: quote it, or mark it proposed and say why');
    expect(mustSupportProblems([{ ...phone, brief_quote: '', proposed: true, reason: 'players hold phones upright' }], { current: [], used: [] })).toEqual([]);
  });
});

describe('renderMustSupport', () => {
  it('renders each item under its group as an MS-n section', () => {
    const body = renderMustSupport([phone, cmd, { ...you, proposed: true, brief_quote: '', reason: 'touch feel needs a person' }]);
    expect(body).toContain("## Where it runs and how it's played");
    expect(body).toContain('### MS-1');
    expect(body).toContain('Checked by the engine: Phone browser, held upright, played by touch, fitting the screen.');
    expect(body).toContain('Not in your brief: suggested because touch feel needs a person');
    expect(body.indexOf("## How it's built")).toBeGreaterThan(body.indexOf('### MS-1'));
  });
});

describe('playRuns', () => {
  it('plans one desktop run when no item is played', () => {
    expect(playRuns([cmd, you])).toEqual([{ viewport: 'desktop', touch: false, fitsScreen: false, items: [] }]);
  });

  it('plans one run per viewport in a fixed order', () => {
    const desk = { ...phone, id: 'MS-4', viewport: 'desktop', input: 'keys', fits_screen: false } as MsItem;
    const runs = playRuns([phone, desk]);
    expect(runs.map((r) => [r.viewport, r.touch, r.fitsScreen])).toEqual([
      ['desktop', false, false],
      ['phone_portrait', true, true],
    ]);
  });
});

describe('gateStatuses', () => {
  it('gives every current item a status and ignores removed ones', () => {
    expect(
      gateStatuses(
        [phone, cmd],
        [
          { item_id: 'MS-1', status: 'met', evidence: 'x' },
          { item_id: 'MS-9', status: 'failing', evidence: 'y' },
        ],
        [],
      ),
    ).toEqual([
      { item_id: 'MS-1', status: 'met', evidence: 'x' },
      { item_id: 'MS-2', status: 'not_measured', evidence: '' },
    ]);
  });

  it('a waiver for good stands unless the milestone met the item', () => {
    const forGood = [{ item_id: 'MS-1', status: 'waived' as const, evidence: 'DEC-12@1' }];
    expect(gateStatuses([phone], [{ item_id: 'MS-1', status: 'failing', evidence: 'f' }], forGood)[0]!.status).toBe('waived');
    expect(gateStatuses([phone], [{ item_id: 'MS-1', status: 'met', evidence: 'm' }], forGood)[0]!.status).toBe('met');
  });
});
