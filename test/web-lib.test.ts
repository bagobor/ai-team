import { ageLabel, documentLink, groupInbox, inboxLabel, newPendingIds, type InboxItem } from '../web/src/lib/inbox.ts';

const item = (id: number, type: InboxItem['type']): InboxItem => ({ id, type, title: `Item ${id}` }) as InboxItem;

describe('groupInbox', () => {
  it('groups approvals before questions and drops empty groups', () => {
    const groups = groupInbox([item(1, 'question'), item(2, 'approval'), item(3, 'question')]);

    expect(groups.map(({ type, label, items }) => [type, label, items.map(({ id }) => id)])).toEqual([
      ['approval', 'Approvals', [2]],
      ['question', 'Questions', [1, 3]],
    ]);
    expect(groupInbox([item(1, 'question')]).map(({ type }) => type)).toEqual(['question']);
    expect(groupInbox([])).toEqual([]);
  });
});

describe('ageLabel', () => {
  it.each([
    [30, 'just now'],
    [59, 'just now'],
    [60, '1 min'],
    [300, '5 min'],
    [3599, '59 min'],
    [7200, '2 h'],
    [86399, '23 h'],
    [172800, '2 d'],
  ])('labels %i seconds as %s', (seconds, label) => {
    expect(ageLabel(seconds)).toBe(label);
  });
});

describe('newPendingIds', () => {
  it('finds only ids that are new', () => {
    expect(newPendingIds([1, 2], [2, 3, 4])).toEqual([3, 4]);
    expect(newPendingIds([1, 2], [1])).toEqual([]);
  });
});

describe('inboxLabel', () => {
  it.each([
    [{ kind: 'cp1' }, 7, 'CP1'],
    [{ kind: 'cp4', milestone: 2 }, 7, 'CP4-M2'],
    [{ kind: 'cr', cr: 'CR-3' }, 7, 'CR-3'],
    [{ kind: 'escalation', taskId: 4 }, 7, 'Q-7'],
    [{ kind: 'qa_cap', milestone: 1 }, 8, 'Q-8'],
  ] as const)('names %j, item %i, as %s', (ref, id, label) => {
    expect(inboxLabel({ id, ref })).toBe(label);
  });
});

describe('documentLink', () => {
  it('points a pin at its project\'s Documents page', () => {
    expect(documentLink('temp conv', 'SPEC-M1@2')).toBe('/projects/temp%20conv/documents#SPEC-M1%402');
  });
});
