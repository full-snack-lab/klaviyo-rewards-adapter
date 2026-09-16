# full-snack-klaviyo-rewards

Connect a Node.js TypeScript application to multiple Klaviyo accounts with OAuth. The package adds database-backed token persistence, typed events, and Infisical secrets to the official `klaviyo-api` SDK.

Requires Node.js 20 or later.

## Install

```sh
npm install full-snack-klaviyo-rewards
```

## Configure the client

Implement `TokenStore` with your database. Encrypt tokens at rest, save each token pair atomically, and implement `runExclusive` with a distributed lock when multiple processes can refresh the same account.

```ts
import {
  FEATURE_SCOPES,
  KlaviyoClient,
  createEvent,
  type OAuthTokens,
  type TokenStore,
} from "full-snack-klaviyo-rewards";

type Events = {
  "Reward Redeemed": { rewardId: string; points: number };
};

type ProfileProperties = {
  loyaltyTier: "gold" | "silver";
};

const tokens: TokenStore = {
  load: async (accountId) => database.tokens.load(accountId),
  save: async (accountId, value: OAuthTokens) =>
    database.tokens.upsert(accountId, value),
};

const client = new KlaviyoClient<Events, ProfileProperties>({
  accountId: "merchant-123",
  credentials: {
    clientId: process.env.KLAVIYO_CLIENT_ID!,
    clientSecret: process.env.KLAVIYO_CLIENT_SECRET!,
  },
  tokenStore: tokens,
});

const pending = await client.beginAuthorization({
  state: "an-unpredictable-session-bound-value",
  redirectUri: "https://app.example.com/oauth/klaviyo/callback",
  scopes: FEATURE_SCOPES,
});

// Store pending.codeVerifier server-side before redirecting.
redirect(pending.authorizationUrl);

await createEvent(client, {
  name: "Reward Redeemed",
  profile: { identifier: "email", email: "customer@example.com" },
  properties: { rewardId: "reward-42", points: 500 },
  uniqueId: "redemption-42",
});
```

At the callback, validate that the returned `state` belongs to the current user. Retrieve and delete its one-time code verifier, then call `client.completeAuthorization`. Authorization codes expire after five minutes.

## Load OAuth credentials from Infisical

`createInfisicalSecrets` uses the official `@infisical/sdk` package and Universal Auth. Alias names remain type-safe.

```ts
import {
  createInfisicalSecrets,
  oauthCredentialsFromInfisical,
} from "full-snack-klaviyo-rewards";

const getSecret = await createInfisicalSecrets({
  universalAuth: {
    clientId: process.env.INFISICAL_CLIENT_ID!,
    clientSecret: process.env.INFISICAL_CLIENT_SECRET!,
  },
  projectId: "project-id",
  environment: "prod",
  secrets: {
    klaviyoClientId: "KLAVIYO_CLIENT_ID",
    klaviyoClientSecret: "KLAVIYO_CLIENT_SECRET",
  } as const,
});

const credentials = await oauthCredentialsFromInfisical(getSecret, {
  clientId: "klaviyoClientId",
  clientSecret: "klaviyoClientSecret",
});
```

Pass `credentials` to `KlaviyoClient`.

## Feature functions

| Function | Purpose | OAuth scope |
| --- | --- | --- |
| `createEvent` | Create a typed Klaviyo event | `events:write` |
| `triggerTransactionalEmail` | Trigger an event-backed transactional flow | `events:write` |
| `triggerMarketingEmail` | Queue an existing campaign for sending | `campaigns:write` |
| `readProfile` | Read a profile by Klaviyo profile ID | `profiles:read` |
| `pullReviews` | Read a filtered, sorted page of reviews | `reviews:read` |

Use only the scopes needed by your application. `FEATURE_SCOPES` contains the four scopes required for every function in the table.

For other endpoints, create any official SDK API with the authenticated session:

```ts
import { FlowsApi } from "klaviyo-api";

const flows = client.api(FlowsApi);
const response = await flows.getFlows();
```

## OAuth behavior

- PKCE uses `S256` and generates a new verifier for each authorization request.
- The official SDK refreshes access tokens shortly before expiration and after one `401` response.
- A successful refresh atomically replaces both stored tokens.
- Concurrent refreshes in one client are deduplicated; `runExclusive` coordinates multiple processes.
- The official SDK retries `429`, `503`, `504`, and `524` responses with exponential backoff.
- Call `client.revoke()` before disconnecting an account.

The API revision follows the installed `klaviyo-api` version. Upgrade that dependency intentionally when adopting a new Klaviyo API revision.
