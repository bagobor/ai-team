import { useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (event: MouseEvent) => {
    // Leave a click that opens a new tab or window to the browser.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
