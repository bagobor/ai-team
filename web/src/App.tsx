import { TaskDetail } from './pages/TaskDetail.tsx';
import { TaskList } from './pages/TaskList.tsx';
import { Link, usePath } from './router.tsx';

function Page({ path }: { path: string }) {
  if (path === '/') return <TaskList />;

  const id = /^\/tasks\/(\d+)\/?$/.exec(path)?.[1];
  // The key starts a new task's live log from nothing.
  if (id !== undefined) return <TaskDetail key={id} id={Number(id)} />;

  return (
    <p className="notice">
      There's no page here. <Link to="/">See all tasks</Link>
    </p>
  );
}

export function App() {
  const path = usePath();
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="7" y="1.8" width="6" height="5" rx="1.2" />
            <rect x="1.5" y="13.2" width="6" height="5" rx="1.2" />
            <rect x="12.5" y="13.2" width="6" height="5" rx="1.2" />
            <path d="M10 6.8v3.2M4.5 13.2V10h11v3.2" />
          </svg>
          <span>AI Team</span>
        </Link>
      </header>
      <main className="wrap">
        <Page path={path} />
      </main>
    </>
  );
}
