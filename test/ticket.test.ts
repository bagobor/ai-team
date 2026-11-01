import { readFileSync } from 'node:fs';
import { parseTicket, TicketError } from '../src/tickets/ticket.ts';

const t1 = readFileSync(new URL('./fixtures/tickets/T-1.md', import.meta.url), 'utf8');

const without = (md: string, field: string) => md.replace(new RegExp(`^${field}:.*\\n`, 'm'), '');
const withField = (md: string, field: string, yaml: string) => md.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: ${yaml}`);

describe('parseTicket', () => {
  it('parses required ticket fields', () => {
    const t = parseTicket(t1);
    expect(t.definition_of_done).toEqual(['node --test']);
    expect(t).toMatchObject({ id: 'T-1', title: 'Add a greeting helper', milestone: 1, specialty: 'engineer', size: 'S' });
    expect(t.touches).toEqual(['src/**']);
    expect(t.ac_refs).toEqual(['AC-1']);
    expect(t.body.trim()).toMatch(/^Add `greet\(name\)`/);
  });

  it.each(['id', 'title', 'milestone', 'ac_refs', 'specialty', 'touches', 'depends_on', 'definition_of_done', 'inputs', 'size'])(
    'requires %s',
    (f) => {
      expect(() => parseTicket(without(t1, f))).toThrow(TicketError);
      expect(() => parseTicket(without(t1, f))).toThrow(new RegExp(f));
    },
  );

  it.each(['../x', 'a/b', '.hidden', '-flag', 'a b', ''])('rejects the unsafe id %j', (id) => {
    expect(() => parseTicket(withField(t1, 'id', JSON.stringify(id)))).toThrow(TicketError);
  });

  it('accepts inputs', () => {
    expect(parseTicket(withField(t1, 'inputs', '[SPEC-M1@2#ac-1, BRIEF]')).inputs).toEqual(['SPEC-M1@2#ac-1', 'BRIEF']);
  });

  it.each(['definition_of_done', 'touches'])('rejects an empty %s', (f) => {
    expect(() => parseTicket(withField(t1, f, '[]'))).toThrow(new RegExp(f));
  });

  it.each([
    ['milestone', '0'],
    ['milestone', '1.5'],
    ['milestone', 'one'],
    ['size', 'XL'],
    ['touches', '"src/**"'],
    ['definition_of_done', '[1]'],
    ['definition_of_done', '[""]'],
  ])('rejects %s: %s', (field, yaml) => {
    expect(() => parseTicket(withField(t1, field, yaml))).toThrow(new RegExp(field));
  });

  it.each([
    ['no front matter', 'just text'],
    ['an unclosed front matter', '---\nid: T-1\n'],
    ['malformed YAML', '---\nid: [\n---\nbody'],
    ['front matter that is not a mapping', '---\n- a\n---\nbody'],
  ])('rejects %s', (_name, md) => {
    expect(() => parseTicket(md)).toThrow(TicketError);
  });

  it('accepts Windows line endings', () => {
    expect(parseTicket(t1.replaceAll('\n', '\r\n')).id).toBe('T-1');
  });
});
