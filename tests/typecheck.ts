import {
	createEvent,
	triggerTransactionalEmail,
	type KlaviyoClient,
} from "../src/index.ts";

type Events = {
	"Order Shipped": { orderId: string; carrier: "ups" | "fedex" };
	"Password Reset Requested": { resetUrl: string };
};

type ProfileProperties = {
	loyaltyTier: "gold" | "silver";
	points: number;
};

export function typeFixtures(
	client: KlaviyoClient<Events, ProfileProperties>,
): void {
	void triggerTransactionalEmail(client, {
		name: "Password Reset Requested",
		profile: { identifier: "id", id: "profile-1" },
		properties: { resetUrl: "https://app.example.com/reset" },
	});

	void createEvent(client, {
		name: "Order Shipped",
		profile: { identifier: "id", id: "profile-1" },
		// @ts-expect-error Event names select their exact property contract.
		properties: { resetUrl: "wrong event properties" },
	});

	void createEvent(client, {
		// @ts-expect-error Unknown event names are rejected.
		name: "Unknown Event",
		profile: { identifier: "id", id: "profile-1" },
		properties: { resetUrl: "https://app.example.com/reset" },
	});
}
