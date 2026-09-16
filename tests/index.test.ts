import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	FEATURE_SCOPES,
	KlaviyoClient,
	createEvent,
	parseOAuthCallback,
	pullReviews,
	readProfile,
	triggerMarketingEmail,
	type OAuthTokens,
	type TokenStore,
} from "../src/index.ts";

type Events = {
	"Order Shipped": { orderId: string; carrier: "ups" | "fedex" };
	"Password Reset Requested": { resetUrl: string };
};

type LoyaltyProperties = {
	loyaltyTier: "gold" | "silver";
	points: number;
};

class MemoryTokenStore implements TokenStore {
	private tokens: OAuthTokens | null = null;

	async load(_accountId: string): Promise<OAuthTokens | null> {
		return this.tokens;
	}

	async save(_accountId: string, tokens: OAuthTokens): Promise<void> {
		this.tokens = structuredClone(tokens);
	}

	async delete(_accountId: string): Promise<void> {
		this.tokens = null;
	}
}

const tokenStore = new MemoryTokenStore();
const eventRequests: Array<{
	body: unknown;
	authorization: string | null;
	revision: string | null;
}> = [];
let refreshCount = 0;
let revokedToken: string | null = null;

const server = setupServer(
	http.post("https://a.klaviyo.com/oauth/token", async ({ request }) => {
		const form = new URLSearchParams(await request.text());
		const refresh = form.get("grant_type") === "refresh_token";
		if (refresh) refreshCount += 1;
		return HttpResponse.json({
			access_token: refresh ? "refreshed-access" : "authorized-access",
			refresh_token: refresh ? "rotated-refresh" : "initial-refresh",
			expires_in: 3600,
			token_type: "bearer",
			scope: FEATURE_SCOPES.join(" "),
		});
	}),
	http.post("https://a.klaviyo.com/oauth/revoke", async ({ request }) => {
		revokedToken = new URLSearchParams(await request.text()).get("token");
		return new HttpResponse(null, { status: 200 });
	}),
	http.post("https://a.klaviyo.com/api/events", async ({ request }) => {
		eventRequests.push({
			body: await request.json(),
			authorization: request.headers.get("authorization"),
			revision: request.headers.get("revision"),
		});
		return new HttpResponse(null, { status: 202 });
	}),
	http.get("https://a.klaviyo.com/api/profiles/profile-1", () =>
		HttpResponse.json({
			data: {
				type: "profile",
				id: "profile-1",
				attributes: {
					email: "sam@example.com",
					properties: { loyaltyTier: "gold", points: 42 },
				},
				links: { self: "https://a.klaviyo.com/api/profiles/profile-1" },
			},
		}),
	),
	http.get("https://a.klaviyo.com/api/reviews", ({ request }) => {
		const url = new URL(request.url);
		if (url.searchParams.get("page[size]") !== "1") {
			return HttpResponse.json({}, { status: 400 });
		}
		return HttpResponse.json({
			data: [
				{
					type: "review",
					id: "review-1",
					attributes: {
						rating: 5,
						content: "Excellent",
						verified: true,
						review_type: "review",
						created: "2026-01-01T00:00:00Z",
						updated: "2026-01-01T00:00:00Z",
						images: [],
					},
					links: { self: "https://a.klaviyo.com/api/reviews/review-1" },
				},
			],
			links: { self: request.url },
		});
	}),
	http.post("https://a.klaviyo.com/api/campaign-send-jobs", () =>
		HttpResponse.json(
			{
				data: {
					type: "campaign-send-job",
					id: "campaign-1",
					attributes: { status: "queued" },
					links: {
						self: "https://a.klaviyo.com/api/campaign-send-jobs/campaign-1",
					},
				},
			},
			{ status: 202 },
		),
	),
);

const client = new KlaviyoClient<Events, LoyaltyProperties>({
	accountId: "merchant-1",
	credentials: { clientId: "client-id", clientSecret: "client-secret" },
	tokenStore,
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(async () => {
	refreshCount = 0;
	revokedToken = null;
	eventRequests.length = 0;
	await tokenStore.save("merchant-1", {
		accessToken: "valid-access",
		refreshToken: "valid-refresh",
		expiresAt: new Date(Date.now() + 3_600_000),
	});
});

afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Klaviyo OAuth client", () => {
	it("completes PKCE auth, rotates tokens, and sends typed events through the SDK", async () => {
		const pending = await client.beginAuthorization({
			state: "merchant-1",
			redirectUri: "https://app.example.com/oauth/callback",
			scopes: FEATURE_SCOPES,
		});
		expect(
			new URL(pending.authorizationUrl).searchParams.get("code_challenge_method"),
		).toBe("S256");
		expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

		await client.completeAuthorization({
			code: "authorization-code",
			codeVerifier: pending.codeVerifier,
			redirectUri: "https://app.example.com/oauth/callback",
		});
		await tokenStore.save("merchant-1", {
			accessToken: "expired-access",
			refreshToken: "initial-refresh",
			expiresAt: new Date(0),
		});

		await Promise.all([
			createEvent(client, {
				name: "Order Shipped",
				profile: { identifier: "email", email: "sam@example.com" },
				properties: { orderId: "order-1", carrier: "ups" },
				uniqueId: "shipment-order-1",
			}),
			createEvent(client, {
				name: "Order Shipped",
				profile: { identifier: "id", id: "profile-1" },
				properties: { orderId: "order-2", carrier: "fedex" },
				uniqueId: "shipment-order-2",
			}),
		]);

		expect(refreshCount).toBe(1);
		expect(await tokenStore.load("merchant-1")).toMatchObject({
			accessToken: "refreshed-access",
			refreshToken: "rotated-refresh",
		});
		const request = eventRequests.find(
			({ body }) =>
				(body as { data: { attributes: { unique_id?: string } } }).data.attributes
					.unique_id === "shipment-order-1",
		);
		expect(request).toMatchObject({
			authorization: "Bearer refreshed-access",
			revision: "2026-07-15",
			body: {
				data: {
					type: "event",
					attributes: {
						unique_id: "shipment-order-1",
						properties: { orderId: "order-1", carrier: "ups" },
					},
				},
			},
		});

		await client.revoke();
		expect(revokedToken).toBe("rotated-refresh");
		expect(await tokenStore.load("merchant-1")).toBeNull();
	});

	it("reads profiles and reviews and queues marketing campaigns", async () => {
		const profile = await readProfile(client, { profileId: "profile-1" });
		expect(profile.attributes.properties?.loyaltyTier).toBe("gold");

		const reviews = await pullReviews(client, { pageSize: 1, sort: "-created" });
		expect(reviews.data[0]?.attributes.rating).toBe(5);

		const job = await triggerMarketingEmail(client, { campaignId: "campaign-1" });
		expect(job.attributes.status).toBe("queued");
	});

	it("parses authorized and denied callbacks", () => {
		expect(
			parseOAuthCallback(
				"https://app.example.com/callback?code=abc&state=merchant-1",
			),
		).toEqual({ status: "authorized", code: "abc", state: "merchant-1" });
		expect(
			parseOAuthCallback(
				"https://app.example.com/callback?error=access_denied&state=merchant-1",
			),
		).toEqual({ status: "denied", error: "access_denied", state: "merchant-1" });
	});
});
