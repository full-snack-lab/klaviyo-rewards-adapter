import {
	CampaignsApi,
	EventsApi,
	ProfilesApi,
	ReviewsApi,
	type CampaignSendJobCreateQuery,
	type EventCreateQueryV2,
	type EventProfileCreateQueryResourceObject,
	type GetReviewResponseDTOCollectionCompoundDocument,
	type PostCampaignSendJobResponseData,
	type ProfileResponsePluralConversationsObjectResourceExtended,
	type ProfileResponsePluralConversationsObjectResourceExtendedAttributes,
} from "klaviyo-api";
import type { EventCatalog, JsonObject, KlaviyoClient } from "./client.ts";

/** OAuth scopes required when every built-in feature is enabled. */
export const FEATURE_SCOPES = [
	"campaigns:write",
	"events:write",
	"profiles:read",
	"reviews:read",
] as const;

/** An OAuth scope used by a built-in feature. */
export type FeatureScope = (typeof FEATURE_SCOPES)[number];

/** Optional profile attributes included when an event identifies a profile. */
export type EventProfileDetails = Readonly<{
	firstName?: string;
	lastName?: string;
	phoneNumber?: string;
	externalId?: string;
	properties?: JsonObject;
}>;

/** Selects exactly one identifier for an event's profile. */
export type EventProfile =
	| Readonly<{ identifier: "id"; id: string }>
	| (Readonly<{ identifier: "email"; email: string }> & EventProfileDetails)
	| (Readonly<{ identifier: "phoneNumber"; phoneNumber: string }> &
			Omit<EventProfileDetails, "phoneNumber">)
	| (Readonly<{ identifier: "externalId"; externalId: string }> &
			Omit<EventProfileDetails, "externalId">);

/**
 * Input for one typed Klaviyo event.
 *
 * @typeParam Name - A name from the client's event catalog.
 * @typeParam Properties - The property shape selected by `Name`.
 */
export type EventInput<
	Name extends string,
	Properties extends JsonObject,
> = Readonly<{
	name: Name;
	profile: EventProfile;
	properties: Properties;
	time?: Date;
	value?: number;
	valueCurrency?: string;
	uniqueId?: string;
	backfill?: boolean;
}>;

/** Input for an event-backed transactional email flow. */
export type TransactionalEmailInput<
	Name extends string,
	Properties extends JsonObject,
> = Omit<EventInput<Name, Properties>, "backfill">;

/** A generated profile resource with consumer-defined custom properties. */
export type KlaviyoProfile<Properties extends JsonObject = JsonObject> = Omit<
	ProfileResponsePluralConversationsObjectResourceExtended,
	"attributes"
> & {
	attributes: Omit<
		ProfileResponsePluralConversationsObjectResourceExtendedAttributes,
		"properties"
	> & { properties?: Properties | null };
};

/** Filtering, pagination, and sorting options for reading reviews. */
export type PullReviewsInput = Readonly<{
	filter?: string;
	pageCursor?: string;
	pageSize?: number;
	sort?: "created" | "-created" | "rating" | "-rating" | "updated" | "-updated";
}>;

/**
 * Creates an event whose properties are selected by its event name.
 *
 * A successful response means Klaviyo accepted the event for asynchronous processing.
 */
export async function createEvent<
	Events extends EventCatalog,
	ProfileProperties extends JsonObject,
	Name extends keyof Events & string,
>(
	client: KlaviyoClient<Events, ProfileProperties>,
	input: EventInput<Name, Events[Name]>,
): Promise<void> {
	assertNonEmpty(input.name, "event name");
	if (input.name.length >= 128) {
		throw new TypeError("event name must be less than 128 characters");
	}
	const query: EventCreateQueryV2 = {
		data: {
			type: "event",
			attributes: {
				properties: input.properties,
				...(input.time === undefined ? {} : { time: input.time }),
				...(input.value === undefined ? {} : { value: input.value }),
				...(input.valueCurrency === undefined
					? {}
					: { valueCurrency: input.valueCurrency }),
				...(input.uniqueId === undefined ? {} : { uniqueId: input.uniqueId }),
				...(input.backfill === undefined ? {} : { backfill: input.backfill }),
				metric: {
					data: {
						type: "metric",
						attributes: { name: input.name },
					},
				},
				profile: { data: eventProfileData(input.profile) },
			},
		},
	};
	await client.api(EventsApi).createEvent(query);
}

/** Triggers an event-backed Klaviyo flow containing transactional email content. */
export async function triggerTransactionalEmail<
	Events extends EventCatalog,
	ProfileProperties extends JsonObject,
	Name extends keyof Events & string,
>(
	client: KlaviyoClient<Events, ProfileProperties>,
	input: TransactionalEmailInput<Name, Events[Name]>,
): Promise<void> {
	await createEvent(client, { ...input, backfill: false });
}

/** Queues an existing Klaviyo marketing campaign for asynchronous sending. */
export async function triggerMarketingEmail<
	Events extends EventCatalog,
	ProfileProperties extends JsonObject,
>(
	client: KlaviyoClient<Events, ProfileProperties>,
	input: Readonly<{ campaignId: string }>,
): Promise<PostCampaignSendJobResponseData> {
	assertNonEmpty(input.campaignId, "campaignId");
	const query: CampaignSendJobCreateQuery = {
		data: { type: "campaign-send-job", id: input.campaignId },
	};
	return (await client.api(CampaignsApi).sendCampaign(query)).body.data;
}

/** Reads a profile by its Klaviyo-generated profile ID. */
export async function readProfile<
	Events extends EventCatalog,
	ProfileProperties extends JsonObject,
>(
	client: KlaviyoClient<Events, ProfileProperties>,
	input: Readonly<{ profileId: string }>,
): Promise<KlaviyoProfile<ProfileProperties>> {
	assertNonEmpty(input.profileId, "profileId");
	const profile = (await client.api(ProfilesApi).getProfile(input.profileId))
		.body.data;
	return profile as KlaviyoProfile<ProfileProperties>;
}

/** Reads one filtered and cursor-paginated page of account reviews. */
export async function pullReviews<
	Events extends EventCatalog,
	ProfileProperties extends JsonObject,
>(
	client: KlaviyoClient<Events, ProfileProperties>,
	input: PullReviewsInput = {},
): Promise<GetReviewResponseDTOCollectionCompoundDocument> {
	return (await client.api(ReviewsApi).getReviews(input)).body;
}

function eventProfileData(
	profile: EventProfile,
): EventProfileCreateQueryResourceObject {
	switch (profile.identifier) {
		case "id":
			assertNonEmpty(profile.id, "profile id");
			return { type: "profile", id: profile.id, attributes: {} };
		case "email":
			assertNonEmpty(profile.email, "profile email");
			return {
				type: "profile",
				attributes: profileAttributes(profile, { email: profile.email }),
			};
		case "phoneNumber":
			assertNonEmpty(profile.phoneNumber, "profile phone number");
			return {
				type: "profile",
				attributes: profileAttributes(profile, {
					phoneNumber: profile.phoneNumber,
				}),
			};
		case "externalId":
			assertNonEmpty(profile.externalId, "profile external id");
			return {
				type: "profile",
				attributes: profileAttributes(profile, {
					externalId: profile.externalId,
				}),
			};
		default:
			return assertNever(profile);
	}
}

function profileAttributes(
	profile: EventProfileDetails,
	identifier:
		| { email: string }
		| { phoneNumber: string }
		| { externalId: string },
): EventProfileCreateQueryResourceObject["attributes"] {
	return {
		...identifier,
		...(profile.firstName === undefined ? {} : { firstName: profile.firstName }),
		...(profile.lastName === undefined ? {} : { lastName: profile.lastName }),
		...(profile.phoneNumber === undefined
			? {}
			: { phoneNumber: profile.phoneNumber }),
		...(profile.externalId === undefined
			? {}
			: { externalId: profile.externalId }),
		...(profile.properties === undefined
			? {}
			: { properties: profile.properties }),
	};
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported profile identifier: ${String(value)}`);
}

function assertNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0) throw new TypeError(`${name} cannot be empty`);
}
