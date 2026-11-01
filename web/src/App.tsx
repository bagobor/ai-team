import { useEffect, useRef, type ReactNode } from 'react';
import { useInbox } from './api.ts';
import { newPendingIds, projectPath } from './lib/inbox.ts';
import { Board } from './pages/Board.tsx';
import { Documents } from './pages/Documents.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Projects } from './pages/Projects.tsx';
import { TaskDetail } from './pages/TaskDetail.tsx';
import { TaskList } from './pages/TaskList.tsx';
import { Link, usePath } from './router.tsx';

const PROJECT_PAGE = /^\/projects\/([^/]+)\/(inbox|board|documents)\/?$/;

function decoded(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function Page({ path }: { path: string }) {
  if (path === '/') return <Wide><Projects /></Wide>;
  if (path === '/inbox') return <Inbox />;
  if (path === '/tasks') return <Wide><TaskList /></Wide>;

  const project = PROJECT_PAGE.exec(path);
  const name = decoded(project?.[1]);
  if (name !== undefined && project?.[2] === 'inbox') return <Inbox key={name} project={name} />;
  if (name !== undefined && project?.[2] === 'board') return <Board key={name} project={name} />;
  if (name !== undefined && project?.[2] === 'documents') return <Documents key={name} project={name} />;

  const id = /^\/tasks\/(\d+)\/?$/.exec(path)?.[1];
  // The key starts a new task's live log from nothing.
  if (id !== undefined) return <Wide><TaskDetail key={id} id={Number(id)} /></Wide>;

  return (
    <p className="notice">
      There's no page here. <Link to="/">See all projects</Link>
    </p>
  );
}

function Wide({ children }: { children: ReactNode }) {
  return <div className="wrap">{children}</div>;
}

function NavLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link to={to} className={active ? 'active' : ''}>
      {children}
    </Link>
  );
}

// Tells the browser about items that turn up after the page has loaded, once the stakeholder has said yes to notifications.
function useInboxNotifications(items: { id: number; title: string; why: string }[] | undefined): void {
  const known = useRef<number[] | null>(null);

  useEffect(() => {
    if (!items) return;
    const ids = items.map(({ id }) => id);
    const fresh = known.current === null ? [] : newPendingIds(known.current, ids);
    known.current = ids;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    for (const { id, title, why } of items) {
      if (fresh.includes(id)) new Notification(title, { body: why, tag: `inbox-${id}` });
    }
  }, [items]);
}

export function App() {
  const path = usePath();
  const { data } = useInbox();
  useInboxNotifications(data?.items);

  const project = decoded(PROJECT_PAGE.exec(path)?.[1]);
  const count = data?.count ?? 0;

  return (
    <div className="app">
      <aside className="side">
        <Link to="/" className="brand">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="7" y="1.8" width="6" height="5" rx="1.2" />
            <rect x="1.5" y="13.2" width="6" height="5" rx="1.2" />
            <rect x="12.5" y="13.2" width="6" height="5" rx="1.2" />
            <path d="M10 6.8v3.2M4.5 13.2V10h11v3.2" />
          </svg>
          <span>AI Team</span>
        </Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" active={path === '/'}>
            Projects
          </NavLink>
          <NavLink to="/inbox" active={path === '/inbox'}>
            Inbox
            {count > 0 && (
              <span className="badge" data-testid="inbox-badge">
                {count}
              </span>
            )}
          </NavLink>
          <NavLink to="/tasks" active={path.startsWith('/tasks')}>
            Tasks
          </NavLink>
          {project !== undefined && (
            <>
              <div className="sep" />
              <div className="nav-project mono">{project}</div>
              <NavLink to={projectPath(project, 'inbox')} active={path === projectPath(project, 'inbox')}>
                Project inbox
              </NavLink>
              <NavLink to={projectPath(project, 'board')} active={path === projectPath(project, 'board')}>
                Board
              </NavLink>
              <NavLink to={projectPath(project, 'documents')} active={path === projectPath(project, 'documents')}>
                Documents
              </NavLink>
            </>
          )}
        </nav>
      </aside>
      <main className="main">
        <div className="scroll">
          <Page path={path} />
        </div>
      </main>
    </div>
  );
}
