import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

// A tiny history router: the app has five screens, a dependency would weigh more than this file.

export interface Route {
  path: string;
  query: URLSearchParams;
}

function current(): Route {
  return { path: window.location.pathname.replace(/\/+$/, "") || "/", query: new URLSearchParams(window.location.search) };
}

const listeners = new Set<() => void>();

export function navigate(to: string, replace = false): void {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const listener of listeners) listener();
  window.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const update = (): void => setRoute(current());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route;
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
