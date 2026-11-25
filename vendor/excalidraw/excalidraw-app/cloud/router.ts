import { useEffect, useState } from "react";

/**
 * Minimal client-side routing for:
 *   /w/:workspaceId               workspace (opens its most recent scene)
 *   /w/:workspaceId/s/:sceneId    a scene
 */
export type Route = { workspaceId: string | null; sceneId: string | null };

const ROUTE_CHANGE = "whiteboard:route";

export const parseRoute = (pathname = window.location.pathname): Route => {
  const match = pathname.match(/^\/w\/([^/]+)(?:\/s\/([^/]+))?\/?$/);
  return {
    workspaceId: match?.[1] ? decodeURIComponent(match[1]) : null,
    sceneId: match?.[2] ? decodeURIComponent(match[2]) : null,
  };
};

export const routePath = (route: Route) =>
  route.workspaceId
    ? `/w/${encodeURIComponent(route.workspaceId)}${
        route.sceneId ? `/s/${encodeURIComponent(route.sceneId)}` : ""
      }`
    : "/";

export const navigate = (route: Route, { replace = false } = {}) => {
  const path = routePath(route);
  if (path === window.location.pathname) {
    return;
  }
  if (replace) {
    window.history.replaceState({}, "", path);
  } else {
    window.history.pushState({}, "", path);
  }
  window.dispatchEvent(new Event(ROUTE_CHANGE));
};

export const useRoute = () => {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const update = () => setRoute(parseRoute());
    window.addEventListener("popstate", update);
    window.addEventListener(ROUTE_CHANGE, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(ROUTE_CHANGE, update);
    };
  }, []);
  return route;
};
