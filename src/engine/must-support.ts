import { oneLine } from './apply/text.ts';

// What the stakeholder's brief says the game must run on, how it's played and how it's built, as a list they confirm.
// Every prototype and milestone is built and checked against it. Items aren't acceptance criteria: they don't go in the
// criteria registry and don't count against the cap on human checks.
export type Viewport = 'desktop' | 'phone_portrait' | 'phone_landscape' | 'tablet';
export type MsInput = 'keys' | 'touch' | 'mouse';
export type MsItem = {
  id: string;
  group: 'runs_on' | 'built_with';
  text: string;
  brief_quote: string;
  check: 'play' | 'command' | 'human';
  // A play item: where the engine plays it, how, and whether the page must fit that screen.
  viewport?: Viewport;
  input?: MsInput | null;
  fits_screen?: boolean;
  // A human item: how the stakeholder checks it.
  how?: string;
  // An item the brief doesn't name, which the PM suggests and says why.
  proposed?: boolean;
  reason?: string;
};
// `used` is every id any version of the list has had, so a removed id is never given to a new item.
export type MustSupportData = { items: MsItem[]; used: string[] };
export type MsStatus = 'met' | 'failing' | 'not_measured' | 'waived';
export type ItemStatus = { item_id: string; status: MsStatus; evidence: string };

export type ViewportSpec = { width: number; height: number; mobile: boolean; touch: boolean };
export const VIEWPORTS: Record<Viewport, ViewportSpec> = {
  desktop: { width: 1280, height: 800, mobile: false, touch: false },
  phone_portrait: { width: 390, height: 844, mobile: true, touch: true },
  phone_landscape: { width: 844, height: 390, mobile: true, touch: true },
  tablet: { width: 820, height: 1180, mobile: false, touch: true },
};
export const VIEWPORT_LABEL: Record<Viewport, string> = {
  desktop: 'Desktop browser',
  phone_portrait: 'Phone browser, held upright',
  phone_landscape: 'Phone browser, held sideways',
  tablet: 'Tablet browser',
};
export const STATUS_LABEL: Record<MsStatus, string> = { met: 'Met', failing: 'Failing', not_measured: 'Not measured', waived: 'Waived' };

// The order the engine plays the viewports in.
const VIEWPORT_ORDER = Object.keys(VIEWPORTS) as Viewport[];
const INPUTS: (MsInput | null)[] = ['keys', 'touch', 'mouse', null];
const ID = /^MS-([1-9]\d*)$/;
const idNumber = (id: string): number => Number(ID.exec(id)?.[1] ?? 0);
const isBlank = (text: unknown) => typeof text !== 'string' || text.trim() === '';

// The ids of the list in force, and every id used so far.
export type MsPrior = { current: string[]; used: string[] };

export function mustSupportProblems(items: MsItem[], prior: MsPrior): string[] {
  if (items.length === 0) return ['The list is empty: name at least what the brief says the game runs on'];
  const problems: string[] = [];
  const highest = Math.max(0, ...prior.used.map(idNumber));
  const seen = new Set<string>();
  for (const item of items) {
    const { id } = item;
    if (!ID.test(id)) problems.push(`${id} is not an id like MS-1`);
    else if (seen.has(id)) problems.push(`${id} is listed more than once`);
    else if (!prior.current.includes(id) && idNumber(id) <= highest) problems.push(`${id} is new, so its id must be above MS-${highest}, the highest used so far`);
    seen.add(id);

    if (isBlank(item.text)) problems.push(`${id} has no text`);
    if (item.proposed) {
      if (isBlank(item.reason)) problems.push(`${id} is proposed and needs a reason`);
    } else if (isBlank(item.brief_quote)) problems.push(`${id} quotes nothing from the brief: quote it, or mark it proposed and say why`);

    if (item.check === 'play') {
      if (item.group === 'built_with') problems.push(`${id} is checked by play, which only a runs_on item can be`);
      if (!item.viewport || !VIEWPORT_ORDER.includes(item.viewport)) problems.push(`${id} is checked by play and needs a viewport`);
      if (item.input === undefined || !INPUTS.includes(item.input)) problems.push(`${id} is checked by play and needs an input: keys, touch, mouse or null`);
    }
    if (item.check === 'human' && isBlank(item.how)) problems.push(`${id} is checked by you and needs a how`);
  }
  return problems;
}

export function nextUsed(prior: MsPrior, items: MsItem[]): string[] {
  return [...new Set([...prior.used, ...items.map(({ id }) => id)])].sort((a, b) => idNumber(a) - idNumber(b));
}

export const itemLine = (item: MsItem): string => `${item.id} ${oneLine(item.text).trim()}`;

const PLAYED_BY: Record<MsInput, string> = { touch: 'touch', keys: 'the keyboard', mouse: 'the mouse' };

function checkedBy(item: MsItem): string {
  if (item.check === 'command') return 'Checked by a command the Tech Lead writes.';
  if (item.check === 'human') return `Checked by you: ${oneLine(item.how ?? '').trim()}`;
  const viewport = VIEWPORT_LABEL[item.viewport ?? 'desktop'];
  const input = item.input ? `, played by ${PLAYED_BY[item.input]}` : '';
  const fits = item.fits_screen ? ', fitting the screen' : '';
  return `Checked by the engine: ${viewport}${input}${fits}.`;
}

function renderItem(item: MsItem): string[] {
  const source = item.proposed ? `Not in your brief: suggested because ${oneLine(item.reason ?? '').trim()}` : `From your brief: “${oneLine(item.brief_quote).trim()}”`;
  return [`### ${item.id}`, '', item.text.trim(), '', source, '', checkedBy(item), ''];
}

const GROUPS: [MsItem['group'], string][] = [
  ['runs_on', "## Where it runs and how it's played"],
  ['built_with', "## How it's built"],
];

// The whole body, so the PM's list and the engine's republished one read the same. Each item is its own section, so a
// pin reads MUST-SUPPORT@v#ms-1.
export function renderMustSupport(items: MsItem[]): string {
  const lines = ["# What the game must run on and how it's played", ''];
  for (const [group, heading] of GROUPS) {
    const members = items.filter((item) => item.group === group);
    if (members.length > 0) lines.push(heading, '', ...members.flatMap(renderItem));
  }
  return lines.join('\n');
}

// One smoke per viewport the play items name. A list with no play items gets today's single desktop smoke.
export type PlayRun = { viewport: Viewport; touch: boolean; fitsScreen: boolean; items: MsItem[] };

export function playRuns(items: MsItem[]): PlayRun[] {
  const played = items.filter(({ check }) => check === 'play');
  if (played.length === 0) return [{ viewport: 'desktop', touch: false, fitsScreen: false, items: [] }];
  return VIEWPORT_ORDER.flatMap((viewport) => {
    const run = played.filter((item) => item.viewport === viewport);
    if (run.length === 0) return [];
    return [{ viewport, touch: run.some(({ input }) => input === 'touch'), fitsScreen: run.some(({ fits_screen }) => fits_screen === true), items: run }];
  });
}

// The status of each item in the list in force: what this gate found, unless the stakeholder waived it for good and
// the gate didn't meet it. An id the list no longer has is ignored.
export function gateStatuses(items: MsItem[], rows: ItemStatus[], forGood: ItemStatus[]): ItemStatus[] {
  return items.map(({ id }) => {
    const row = rows.find(({ item_id }) => item_id === id);
    if (row?.status === 'met') return row;
    const waived = forGood.find(({ item_id, status }) => item_id === id && status === 'waived');
    if (waived) return waived;
    return row ?? { item_id: id, status: 'not_measured', evidence: '' };
  });
}
