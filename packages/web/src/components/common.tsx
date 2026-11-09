import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { errorMessage } from '../lib/api';
import { navigate } from '../lib/routes';

/** In-app link: client-side navigation for plain left clicks, normal browser behaviour otherwise. */
export function Link({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a {...rest} href={href} onClick={onClick}>
      {children}
    </a>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="banner banner-error" role="alert">
      {errorMessage(error)}
    </div>
  );
}

export function Spinner() {
  return <div className="muted">Loading…</div>;
}
