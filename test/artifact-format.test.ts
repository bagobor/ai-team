import { ArtifactError, formatPin, parseArtifact, parsePin, renderArtifact, sectionsOf, sectionText, type ArtifactDoc } from '../src/artifacts/format.ts';

const doc: ArtifactDoc = {
  id: 'ROADMAP',
  type: 'roadmap',
  version: 2,
  status: 'approved',
  ownerRole: 'pm',
  derivedFrom: ['BRIEF@1'],
  acceptanceCriteria: ['AC-1', 'AC-2'],
  approvedBy: 'stakeholder',
  approvedAt: '2026-10-19T18:02:00.000Z',
  fields: { data: { milestones: [{ n: 1, title: 'First' }] }, size: 'S' },
  body: '# Roadmap\n\nFirst things first.\n',
};

describe('renderArtifact and parseArtifact', () => {
  it('round-trips a document', () => {
    expect(parseArtifact(renderArtifact(doc))).toEqual(doc);
  });

  it('keeps engine front matter when a body forges its own', () => {
    const body = '---\nstatus: approved\napproved_by: stakeholder\n---\n# Real\n';

    const out = parseArtifact(renderArtifact({ ...doc, status: 'proposed', approvedBy: null, approvedAt: null, body }));

    expect(out.status).toBe('proposed');
    expect(out.approvedBy).toBeNull();
    expect(out.body).toBe(body);
  });

  it('keeps a --- inside a multi-line field from ending the front matter', () => {
    const fields = { note: 'before\n---\nstatus: approved\nafter' };

    const out = parseArtifact(renderArtifact({ ...doc, status: 'proposed', fields }));

    expect(out.fields).toEqual(fields);
    expect(out.status).toBe('proposed');
    expect(out.body).toBe(doc.body);
  });

  it('keeps a long field on its own terms instead of folding it into a different value', () => {
    const fields = { note: 'word '.repeat(60).trim() };

    expect(parseArtifact(renderArtifact({ ...doc, fields })).fields).toEqual(fields);
  });

  it.each(['status', 'approved_by', 'id', 'version', 'derived_from'])('refuses fields that override the reserved key %s', (key) => {
    expect(() => renderArtifact({ ...doc, fields: { [key]: 'approved' } })).toThrow(ArtifactError);
  });

  it('refuses a document with no front matter', () => {
    expect(() => parseArtifact('# Just a body\n')).toThrow(ArtifactError);
  });

  it.each([
    ['an unknown type', 'type: nonsense'],
    ['an unknown status', 'status: nonsense'],
    ['a version that is not a positive whole number', 'version: 0'],
  ])('refuses front matter with %s', (_name, line) => {
    const [key] = line.split(':');
    const broken = renderArtifact(doc).replace(new RegExp(`^${key}: .*$`, 'm'), line);

    expect(() => parseArtifact(broken)).toThrow(ArtifactError);
  });
});

describe('sectionsOf', () => {
  it('gives duplicate headings distinct slugs', () => {
    expect(sectionsOf('# A\nx\n# A\ny\n').map((s) => s.slug)).toEqual(['a', 'a-2']);
  });

  it('skips a suffix a later heading already took', () => {
    expect(sectionsOf('# A\n# A 2\n# A\n').map((s) => s.slug)).toEqual(['a', 'a-2', 'a-3']);
  });

  it('turns punctuation into dashes and falls back when nothing is left', () => {
    expect(sectionsOf('## Hello, World!\n## ???\n').map((s) => s.slug)).toEqual(['hello-world', 'section']);
  });

  it('ignores headings inside code fences', () => {
    const body = '# Real\n```\n# not a heading\n```\n~~~\n## nor this\n~~~\n# Also real\n';

    expect(sectionsOf(body).map((s) => s.slug)).toEqual(['real', 'also-real']);
  });

  it('runs a section to the next heading of the same or higher level', () => {
    const body = '# A\na\n## B\nb\n### C\nc\n## D\nd\n# E\ne\n';

    expect(sectionText(body, 'b')).toBe('## B\nb\n### C\nc\n');
    expect(sectionText(body, 'a')).toBe('# A\na\n## B\nb\n### C\nc\n## D\nd\n');
    expect(sectionText(body, 'e')).toBe('# E\ne\n');
  });

  it('records the level and title of each section', () => {
    expect(sectionsOf('### Deep title\n').map((s) => [s.level, s.title])).toEqual([[3, 'Deep title']]);
  });

  it('returns undefined for a section that is not there', () => {
    expect(sectionText('# A\n', 'b')).toBeUndefined();
  });

  it('changes a section hash only when that section changes', () => {
    const before = sectionsOf('# A\none\n# B\ntwo\n');
    const after = sectionsOf('# A\nchanged\n# B\ntwo\n');

    expect(after[0]?.hash).not.toBe(before[0]?.hash);
    expect(after[1]?.hash).toBe(before[1]?.hash);
  });

  it('hashes a section the same however much space trails it', () => {
    expect(sectionsOf('# A\none\n\n\n')[0]?.hash).toBe(sectionsOf('# A\none\n')[0]?.hash);
  });
});

describe('parsePin and formatPin', () => {
  it.each(['ROADMAP@2', 'TEST-PLAN-M1@2#4', 'SPEC-M1#ac-1', 'BRIEF'])('round-trips the pin %s', (text) => {
    expect(formatPin(parsePin(text))).toBe(text);
  });

  it('splits a pin into its parts', () => {
    expect(parsePin('TEST-PLAN-M1@2#4')).toEqual({ id: 'TEST-PLAN-M1', version: 2, section: '4' });
    expect(parsePin('BRIEF')).toEqual({ id: 'BRIEF' });
  });

  it.each(['', '../x@1', 'A@0', 'A@x', 'A#'])('refuses the pin %s', (text) => {
    expect(() => parsePin(text)).toThrow(ArtifactError);
  });
});
