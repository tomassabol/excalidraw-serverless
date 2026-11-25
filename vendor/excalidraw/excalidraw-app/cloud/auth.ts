import { type User, UserManager, WebStorageStateStore } from "oidc-client-ts";

import { loadConfig } from "./config";

/**
 * Cognito sign-in with the authorization code flow + PKCE (no client secret).
 * Tokens live in localStorage so a reload keeps the session; the refresh
 * token renews them in the background.
 */
let managerPromise: Promise<UserManager> | null = null;

export const getUserManager = () => {
  managerPromise ??= loadConfig().then(
    (config) =>
      new UserManager({
        authority: config.auth.authority,
        client_id: config.auth.clientId,
        redirect_uri: `${window.location.origin}${config.auth.redirectPath}`,
        post_logout_redirect_uri: `${window.location.origin}/`,
        response_type: "code",
        scope: "openid email profile",
        userStore: new WebStorageStateStore({ store: window.localStorage }),
        automaticSilentRenew: true,
        // Cognito does not support the OIDC session-check iframe
        monitorSession: false,
      }),
  );
  return managerPromise;
};

const RETURN_TO_KEY = "whiteboard:returnTo";

export const isCallbackRoute = async () => {
  const config = await loadConfig();
  return window.location.pathname === config.auth.redirectPath;
};

/** Returns the signed-in user, renewing expired tokens when possible. */
export const getUser = async (): Promise<User | null> => {
  const manager = await getUserManager();
  const user = await manager.getUser();
  if (!user) {
    return null;
  }
  if (!user.expired) {
    return user;
  }
  try {
    return await manager.signinSilent();
  } catch {
    await manager.removeUser();
    return null;
  }
};

export const signIn = async () => {
  sessionStorage.setItem(
    RETURN_TO_KEY,
    window.location.pathname + window.location.search,
  );
  const manager = await getUserManager();
  await manager.signinRedirect();
};

/** Completes the redirect from Cognito and returns where to go next. */
export const completeSignIn = async () => {
  const manager = await getUserManager();
  const user = await manager.signinRedirectCallback();
  const returnTo = sessionStorage.getItem(RETURN_TO_KEY) || "/";
  sessionStorage.removeItem(RETURN_TO_KEY);
  return { user, returnTo };
};

export const signOut = async () => {
  const [manager, config] = await Promise.all([getUserManager(), loadConfig()]);
  await manager.removeUser();
  // Cognito's logout endpoint isn't in its OIDC metadata, so build it here.
  const url = new URL(`${config.auth.domain}/logout`);
  url.searchParams.set("client_id", config.auth.clientId);
  url.searchParams.set("logout_uri", `${window.location.origin}/`);
  window.location.assign(url.toString());
};

export const getAccessToken = async () => {
  const user = await getUser();
  return user?.access_token ?? null;
};
