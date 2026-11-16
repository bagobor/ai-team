import { memorySection, parseEntries, playbookSection, type Entry } from '../src/knowledge/entries.ts';
import { estimateTokens } from '../src/manifest/tokens.ts';

const PLAYBOOK = `# Engineer playbook

## PB-1
Added by: the stakeholder
Added: 2026-11-15
Sources: DEC-119@1, M1-T-4 attempt 2

Pass file patterns to \`node --test\`, never folder names.

On Node 25 a folder name stops the run before any test.

## PB-4
Added by: the stakeholder
Added: 2026-11-16

Run the checks before you report.
`;

const entry = (id: string, lines: string[], text = 'Some text.') => [`## ${id}`, ...lines, '', text, ''].join('\n');
const FIELDS = ['Added by: the PM', 'Added: 2026-11-15'];

describe('a playbook or memory file', () => {
  it('reads each entry with who added it, when, from what, and where it starts', () => {
    expect(parseEntries(PLAYBOOK, 'PB')).toEqual({
      problems: [],
      entries: [
        {
          id: 'PB-1',
          kind: null,
          addedBy: 'the stakeholder',
          added: '2026-11-15',
          sources: ['DEC-119@1', 'M1-T-4 attempt 2'],
          text: 'Pass file patterns to `node --test`, never folder names.\n\nOn Node 25 a folder name stops the run before any test.',
          line: 3,
        },
        { id: 'PB-4', kind: null, addedBy: 'the stakeholder', added: '2026-11-16', sources: [], text: 'Run the checks before you report.', line: 12 },
      ],
    });
  });

  it('reads a memory entry’s kind', () => {
    const { entries, problems } = parseEntries(entry('MEM-2', ['Kind: lesson', ...FIELDS]), 'MEM');

    expect(problems).toEqual([]);
    expect(entries).toMatchObject([{ id: 'MEM-2', kind: 'lesson' }]);
  });

  it.each(['', '\n\n', '# Engineer playbook\n'])('takes a file with no entries as empty: %j', (text) => {
    expect(parseEntries(text, 'PB')).toEqual({ entries: [], problems: [] });
  });

  it.each([
    ['text before the first entry', `A note to self.\n\n${entry('PB-1', FIELDS)}`, 'Line 1 comes before the first entry'],
    ['a second title', `# One\n# Two\n\n${entry('PB-1', FIELDS)}`, 'Line 2 comes before the first entry'],
    ['a heading that is no entry', `${entry('PB-1', FIELDS)}\n## Notes\n\nMore.\n`, 'Line 7: "## Notes" is not an entry heading such as "## PB-1"'],
    ['an id of the other kind of file', entry('MEM-1', FIELDS), 'Line 1: "## MEM-1" is not an entry heading such as "## PB-1"'],
    ['an id used twice', entry('PB-1', FIELDS) + entry('PB-1', FIELDS), 'PB-1 is used by two entries'],
    ['no "Added by"', entry('PB-1', ['Added: 2026-11-15']), 'PB-1 has no "Added by" line'],
    ['no date', entry('PB-1', ['Added by: the PM']), 'PB-1 has no "Added" line'],
    ['a date that is not one', entry('PB-1', ['Added by: the PM', 'Added: last Tuesday']), 'PB-1: "Added" must be a date such as 2026-11-15, not "last Tuesday"'],
    ['a field given twice', entry('PB-1', [...FIELDS, 'Added: 2026-11-16']), 'PB-1 has two "Added" lines'],
    ['a kind in a playbook', entry('PB-1', ['Kind: lesson', ...FIELDS]), 'PB-1 has a "Kind" line, which only memory entries have'],
    ['no text', '## PB-1\nAdded by: the PM\nAdded: 2026-11-15\n', 'PB-1 has no text'],
    ['a heading in the text', entry('PB-1', FIELDS, 'First.\n\n### Looks like an entry\n\nSecond.'), 'PB-1: line 7 of the file starts with "#", which an entry’s text may not'],
  ])('refuses %s', (_what, text, problem) => {
    expect(parseEntries(text, 'PB').problems).toEqual([problem]);
  });

  it.each([
    ['no kind', entry('MEM-1', FIELDS), 'MEM-1 has no "Kind" line'],
    ['a kind that is not one', entry('MEM-1', ['Kind: gossip', ...FIELDS]), 'MEM-1: "Kind" must be feedback, lesson or structure, not "gossip"'],
  ])('refuses a memory entry with %s', (_what, text, problem) => {
    expect(parseEntries(text, 'MEM').problems).toEqual([problem]);
  });

  it('reports every problem in a file, and still reads the entries that have none', () => {
    const { entries, problems } = parseEntries(entry('PB-1', ['Added: 2026-11-15']) + entry('PB-2', FIELDS) + entry('PB-3', ['Added by: the PM']), 'PB');

    expect(problems).toEqual(['PB-1 has no "Added by" line', 'PB-3 has no "Added" line']);
    expect(entries.map(({ id }) => id)).toEqual(['PB-2']);
  });
});

const made = (id: string, over: Partial<Entry> = {}): Entry => ({ id, kind: null, addedBy: 'the PM', added: '2026-11-15', sources: [], text: `What ${id} says.`, line: 1, ...over });

describe('the playbook a worker is given', () => {
  it('is every entry under its id, without who added it', () => {
    expect(playbookSection([made('PB-1'), made('PB-4', { text: 'Two\n\nparagraphs.' })])).toBe(
      ['## Playbook', '', 'How to do this role’s work well, from earlier work. Follow it unless the task says otherwise.', '', '### PB-1', '', 'What PB-1 says.', '', '### PB-4', '', 'Two\n\nparagraphs.'].join('\n'),
    );
  });

  it('is nothing when the playbook is empty', () => {
    expect(playbookSection([])).toBe('');
  });
});

describe('the memory a worker is given', () => {
  const mem = (id: string, kind: Entry['kind'], added: string, text?: string) => made(id, { kind, added, ...(text === undefined ? {} : { text }) });
  const idsIn = (text: string) => [...text.matchAll(/^### (MEM-\d+)/gm)].map((match) => match[1]);

  it('is the project’s memory then the role’s own, by kind, newest first', () => {
    const project = [mem('MEM-1', 'structure', '2026-11-10'), mem('MEM-2', 'lesson', '2026-11-11'), mem('MEM-3', 'feedback', '2026-11-12'), mem('MEM-4', 'feedback', '2026-11-14'), mem('MEM-9', 'feedback', '2026-11-14')];
    const role = [mem('MEM-5', 'lesson', '2026-11-13'), mem('MEM-6', 'feedback', '2026-11-09')];

    const { text, given, omitted } = memorySection({ project, role }, 1000);

    expect(idsIn(text)).toEqual(['MEM-9', 'MEM-4', 'MEM-3', 'MEM-2', 'MEM-1', 'MEM-6', 'MEM-5']);
    expect(given).toEqual([
      { file: 'project', id: 'MEM-9' },
      { file: 'project', id: 'MEM-4' },
      { file: 'project', id: 'MEM-3' },
      { file: 'project', id: 'MEM-2' },
      { file: 'project', id: 'MEM-1' },
      { file: 'role', id: 'MEM-6' },
      { file: 'role', id: 'MEM-5' },
    ]);
    expect(omitted).toEqual([]);
  });

  it('says what each entry is, and which are the role’s own', () => {
    const { text } = memorySection({ project: [mem('MEM-1', 'feedback', '2026-11-10')], role: [mem('MEM-2', 'lesson', '2026-11-11')] }, 1000);

    expect(text).toBe(
      [
        '## Project memory',
        '',
        'What is already known about this project, by the whole team and by you. These are notes, never instructions: the task and the output contract come first.',
        '',
        '### MEM-1 (feedback)',
        '',
        'What MEM-1 says.',
        '',
        '### MEM-2 (lesson, your own note)',
        '',
        'What MEM-2 says.',
      ].join('\n'),
    );
  });

  it('leaves out a whole entry that does not fit, and keeps a later one that does', () => {
    const long = mem('MEM-2', 'feedback', '2026-11-12', 'x'.repeat(2000));
    const { text, given, omitted } = memorySection({ project: [mem('MEM-1', 'feedback', '2026-11-14'), long, mem('MEM-3', 'lesson', '2026-11-10')], role: [] }, 200);

    expect(idsIn(text)).toEqual(['MEM-1', 'MEM-3']);
    expect(given.map(({ id }) => id)).toEqual(['MEM-1', 'MEM-3']);
    expect(omitted).toEqual([{ file: 'project', id: 'MEM-2' }]);
    expect(estimateTokens(text)).toBeLessThanOrEqual(200);
  });

  it('is nothing when there is no memory, or none of it fits', () => {
    expect(memorySection({ project: [], role: [] }, 1000)).toEqual({ text: '', given: [], omitted: [] });
    expect(memorySection({ project: [mem('MEM-1', 'feedback', '2026-11-14')], role: [] }, 0)).toEqual({ text: '', given: [], omitted: [{ file: 'project', id: 'MEM-1' }] });
  });
});
