export type RuntimeConfig = {
  region: string;
  apiBaseUrl: string;
  auth: {
    /** OIDC issuer (Cognito user pool URL). */
    authority: string;
    /** Cognito domain, e.g. https://xyz.auth.eu-central-1.amazoncognito.com */
    domain: string;
    clientId: string;
    redirectPath: string;
  };
};

let configPromise: Promise<RuntimeConfig> | null = null;

/** Runtime config written by CDK next to index.html (proxied in dev). */
export const loadConfig = () => {
  configPromise ??= fetch("/config.json", { cache: "no-store" }).then(
    async (res) => {
      if (!res.ok) {
        throw new Error(`Could not load /config.json (${res.status})`);
      }
      return (await res.json()) as RuntimeConfig;
    },
  );
  return configPromise;
};
