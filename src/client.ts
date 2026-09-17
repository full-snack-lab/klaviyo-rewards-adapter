import {
	OAuthApi,
	OAuthSession,
	Pkce,
	RetryWithExponentialBackoff,
	type CreatedTokens,
	type Session,
	type TokenStorage,
} from "klaviyo-api";

/** A JSON scalar value. */
export type JsonPrimitive = string | number | boolean | null;

/** A recursively JSON-serializable value. */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** A readonly JSON object accepted at Klaviyo API boundaries. */
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

/** Maps Klaviyo event names to their required event-property shapes. */
export type EventCatalog = Readonly<Record<string, JsonObject>>;

/** OAuth client credentials issued for a Klaviyo application. */
export type OAuthCredentials = Readonly<{
	clientId: string;
	clientSecret: string;
}>;

/**
 * The token pair and absolute access-token expiration persisted for one
 * Klaviyo account.
 */
export type OAuthTokens = Readonly<{
	accessToken: string;
	refreshToken: string;
	expiresAt: Date;
}>;

/**
 * Persists OAuth token pairs for Klaviyo accounts.
 *
 * @remarks Implementations must save each token pair atomically. Provide
 * {@link TokenStore.runExclusive} with a distributed lock when multiple
 * processes can refresh the same account; the client already deduplicates
 * refreshes within one process.
 */
export interface TokenStore {
	/** Loads the latest token pair, or `null` when the account is not connected. */
	load(accountId: string): Promise<OAuthTokens | null>;

	/** Atomically replaces both tokens and their expiration for the account. */
	save(accountId: string, tokens: OAuthTokens): Promise<void>;

	/** Deletes stored credentials after Klaviyo confirms revocation. */
	delete?(accountId: string): Promise<void>;

	/**
	 * Runs a token refresh operation exclusively for one account.
	 *
	 * Implementations must release the lock whether `operation` resolves or rejects.
	 */
	runExclusive?<Value>(
		accountId: string,
		operation: () => Promise<Value>,
	): Promise<Value>;
}

/** Values required to start a PKCE authorization request. */
export type BeginAuthorizationInput = Readonly<{
	state: string;
	redirectUri: string;
	scopes: readonly string[];
}>;

/**
 * The redirect URL and verifier produced for a pending authorization.
 *
 * Store `codeVerifier` server-side and associate it with the OAuth state until
 * the callback is handled.
 */
export type PendingAuthorization = Readonly<{
	authorizationUrl: string;
	codeVerifier: string;
}>;

/**
 * The authorized or denied result parsed from an OAuth callback.
 *
 * Denied callbacks may omit `state`; callers must still validate it whenever
 * the authorization server returns one.
 */
export type OAuthCallback =
	| Readonly<{ status: "authorized"; code: string; state: string }>
	| Readonly<{
			status: "denied";
			error: string;
			errorDescription?: string;
			state?: string;
	  }>;

/** Values required to exchange an authorization code for tokens. */
export type CompleteAuthorizationInput = Readonly<{
	code: string;
	codeVerifier: string;
	redirectUri: string;
}>;

/** Configures one account-backed Klaviyo client. */
export type KlaviyoClientOptions = Readonly<{
	accountId: string;
	credentials: OAuthCredentials;
	tokenStore: TokenStore;
}>;

/** A generated Klaviyo API class accepted by {@link KlaviyoClient.api}. */
export type KlaviyoApiConstructor<Api> = new (session: Session) => Api;

/**
 * Handles OAuth and creates authenticated instances of the official Klaviyo SDK APIs.
 *
 * @remarks The underlying SDK refreshes expiring tokens and retries supported
 * transient failures. Refreshes are deduplicated within this client; cross-process
 * serialization depends on {@link TokenStore.runExclusive}.
 *
 * @typeParam Events - Event names and their required property shapes.
 * @typeParam ProfileProperties - Custom properties expected on returned profiles.
 */
export class KlaviyoClient<
	Events extends EventCatalog = EventCatalog,
	ProfileProperties extends JsonObject = JsonObject,
> {
	/** Consumer-defined identifier used to load and save account tokens. */
	readonly accountId: string;
	declare private readonly eventTypes: Events;
	declare private readonly profileProperties: ProfileProperties;

	private readonly credentials: OAuthCredentials;
	private readonly tokenStore: TokenStore;
	private readonly oauth: OAuthApi;
	private readonly session: Session;

	/**
	 * Creates a client for one Klaviyo account.
	 *
	 * @throws TypeError if the account ID or either OAuth credential is empty.
	 */
	constructor(options: KlaviyoClientOptions) {
		assertNonEmpty(options.accountId, "accountId");
		assertNonEmpty(options.credentials.clientId, "clientId");
		assertNonEmpty(options.credentials.clientSecret, "clientSecret");
		this.accountId = options.accountId;
		this.credentials = options.credentials;
		this.tokenStore = options.tokenStore;
		const storage = new TokenStorageAdapter(options.tokenStore);
		this.oauth = new LockedOAuthApi(
			options.credentials.clientId,
			options.credentials.clientSecret,
			storage,
			options.tokenStore,
		);
		this.session = new OAuthSession(
			options.accountId,
			this.oauth,
			new RetryWithExponentialBackoff(),
		);
	}

	/**
	 * Creates a new PKCE verifier and Klaviyo authorization URL.
	 *
	 * @remarks Store the verifier server-side before redirecting the user. This
	 * method does not persist authorization state. Duplicate scopes are removed
	 * while preserving their first-seen order.
	 *
	 * @throws TypeError if `state` or `redirectUri` is empty, or if no scopes are
	 * provided.
	 */
	async beginAuthorization(
		input: BeginAuthorizationInput,
	): Promise<PendingAuthorization> {
		assertNonEmpty(input.state, "state");
		assertNonEmpty(input.redirectUri, "redirectUri");
		if (input.scopes.length === 0) throw new TypeError("scopes cannot be empty");
		const { codeVerifier, codeChallenge } = Pkce.generateCodes();
		return {
			authorizationUrl: this.oauth.generateAuthorizeUrl(
				input.state,
				[...new Set(input.scopes)].join(" "),
				String(codeChallenge),
				input.redirectUri,
			),
			codeVerifier: String(codeVerifier),
		};
	}

	/**
	 * Exchanges an authorization code and atomically saves the returned token pair.
	 *
	 * @returns The same token pair persisted through {@link TokenStore.save}.
	 * @throws TypeError if the code, verifier, or redirect URI is empty.
	 */
	async completeAuthorization(
		input: CompleteAuthorizationInput,
	): Promise<OAuthTokens> {
		assertNonEmpty(input.code, "code");
		assertNonEmpty(input.codeVerifier, "codeVerifier");
		assertNonEmpty(input.redirectUri, "redirectUri");
		return this.oauth.createTokens(
			this.accountId,
			input.codeVerifier,
			input.code,
			input.redirectUri,
		);
	}

	/**
	 * Revokes the stored refresh token.
	 *
	 * @remarks After Klaviyo confirms revocation, the client calls
	 * {@link TokenStore.delete} when implemented. Stored tokens are retained if
	 * the revocation request fails.
	 *
	 * @throws TypeError if the store has no valid token pair for this account.
	 * @throws Error if Klaviyo rejects the revocation request.
	 */
	async revoke(): Promise<void> {
		const tokens = validTokens(await this.tokenStore.load(this.accountId));
		const credentials = Buffer.from(
			`${this.credentials.clientId}:${this.credentials.clientSecret}`,
		).toString("base64");
		const response = await fetch("https://a.klaviyo.com/oauth/revoke", {
			method: "POST",
			headers: {
				Authorization: `Basic ${credentials}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				token: tokens.refreshToken,
				token_type_hint: "refresh_token",
			}),
		});
		if (!response.ok) {
			throw new Error(`Klaviyo token revocation failed (${response.status})`);
		}
		await this.tokenStore.delete?.(this.accountId);
	}

	/**
	 * Creates an authenticated official SDK API instance.
	 *
	 * A new API object is created on every call and shares this client's OAuth
	 * session, retry policy, and token store.
	 */
	api<Api>(ApiClass: KlaviyoApiConstructor<Api>): Api {
		return new ApiClass(this.session);
	}
}

/**
 * Parses an OAuth redirect into an authorized or denied result.
 *
 * @remarks String inputs must be absolute URLs. Pass `URLSearchParams` when only
 * callback query parameters are available. An OAuth `error` takes precedence
 * over any authorization code in the same callback.
 *
 * @throws TypeError if a string is not a valid absolute URL, or when neither an
 * OAuth error nor both `code` and `state` are present.
 */
export function parseOAuthCallback(
	callback: string | URL | URLSearchParams,
): OAuthCallback {
	let params: URLSearchParams;
	try {
		if (typeof callback === "string") {
			params = new URL(callback).searchParams;
		} else if (callback instanceof URL) {
			params = callback.searchParams;
		} else {
			params = callback;
		}
	} catch (cause) {
		throw new TypeError("OAuth callback is not a valid URL", { cause });
	}
	const error = params.get("error");
	if (error) {
		const state = params.get("state") ?? undefined;
		const errorDescription = params.get("error_description") ?? undefined;
		return {
			status: "denied",
			error,
			...(errorDescription ? { errorDescription } : {}),
			...(state ? { state } : {}),
		};
	}
	const code = params.get("code");
	const state = params.get("state");
	if (!code || !state) {
		throw new TypeError("OAuth callback is missing code or state");
	}
	return { status: "authorized", code, state };
}

class TokenStorageAdapter implements TokenStorage {
	constructor(private readonly store: TokenStore) {}

	async retrieve(accountId: string): Promise<OAuthTokens> {
		return validTokens(await this.store.load(accountId));
	}

	async save(accountId: string, tokens: CreatedTokens): Promise<void> {
		await this.store.save(accountId, tokens);
	}
}

class LockedOAuthApi extends OAuthApi {
	private readonly refreshes = new Map<string, Promise<CreatedTokens>>();

	constructor(
		clientId: string,
		clientSecret: string,
		storage: TokenStorage,
		private readonly store: TokenStore,
	) {
		super(clientId, clientSecret, storage);
	}

	override async refreshTokens(
		accountId: string,
		staleRefreshToken?: string,
	): Promise<CreatedTokens> {
		const active = this.refreshes.get(accountId);
		if (active) return active;

		const refresh = async (): Promise<CreatedTokens> => {
			const current = validTokens(await this.store.load(accountId));
			if (
				staleRefreshToken !== undefined &&
				current.refreshToken !== staleRefreshToken &&
				current.expiresAt.getTime() - Date.now() >= 30_000
			) {
				return current;
			}
			return super.refreshTokens(accountId, current.refreshToken);
		};
		const pending = (
			this.store.runExclusive
				? this.store.runExclusive(accountId, refresh)
				: refresh()
		).finally(() => this.refreshes.delete(accountId));
		this.refreshes.set(accountId, pending);
		return pending;
	}
}

function validTokens(tokens: OAuthTokens | null): OAuthTokens {
	if (
		tokens === null ||
		tokens.accessToken.length === 0 ||
		tokens.refreshToken.length === 0 ||
		!(tokens.expiresAt instanceof Date) ||
		!Number.isFinite(tokens.expiresAt.getTime())
	) {
		throw new TypeError("No valid OAuth tokens were found for this account");
	}
	return tokens;
}

function assertNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0) throw new TypeError(`${name} cannot be empty`);
}
