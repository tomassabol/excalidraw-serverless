import { useEffect, useState } from "react";

import { completeSignIn, getUser, isCallbackRoute, signIn } from "./auth";

import "./cloud.scss";

type State =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "signed-in" }
  | { kind: "error"; message: string };

/**
 * Renders the app only for a signed-in user. Handles the redirect back from
 * Cognito (/auth/callback) and shows a sign-in screen otherwise.
 */
export const AuthGate = ({ children }: { children: React.ReactNode }) => {
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (await isCallbackRoute()) {
          const { returnTo } = await completeSignIn();
          window.history.replaceState({}, "", returnTo);
          if (!cancelled) {
            setState({ kind: "signed-in" });
          }
          return;
        }
        const user = await getUser();
        if (!cancelled) {
          setState({ kind: user ? "signed-in" : "signed-out" });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ kind: "error", message: (error as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "signed-in") {
    return <>{children}</>;
  }

  return (
    <div className="cloud-gate">
      <div className="cloud-gate__card">
        <h1 className="cloud-gate__title">Whiteboard</h1>
        {state.kind === "checking" && (
          <p className="cloud-gate__text">Loading…</p>
        )}
        {state.kind === "signed-out" && (
          <>
            <p className="cloud-gate__text">Sign in to open your workspaces.</p>
            <button
              type="button"
              className="cloud-gate__button"
              onClick={() => void signIn()}
            >
              Sign in
            </button>
          </>
        )}
        {state.kind === "error" && (
          <>
            <p className="cloud-gate__text">Sign-in failed: {state.message}</p>
            <button
              type="button"
              className="cloud-gate__button"
              onClick={() => {
                window.history.replaceState({}, "", "/");
                void signIn();
              }}
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
};
