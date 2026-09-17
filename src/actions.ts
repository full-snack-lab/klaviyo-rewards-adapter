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

/**
 * OAuth scopes required to use every feature exported by this package.
 *
 * Request only the individual scopes your application uses when the complete
 * set is unnecessary.
 */
export const FEATURE_SCOPES = [
  "campaigns:write",
  "events:write",
  "profiles:read",
  "reviews:read",
] as const;

/** An OAuth scope used by a built-in feature. */
export type FeatureScope = (typeof FEATURE_SCOPES)[number];

/**
 * Optional attributes sent when an event identifies a profile by email, phone
 * number, or external ID.
 *
 * Undefined attributes are omitted from the Klaviyo request.
 */
export type EventProfileDetails = Readonly<{
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  externalId?: string;
  properties?: JsonObject;
}>;

/**
 * Selects exactly one identifier for an event's profile.
 *
 * A Klaviyo-generated profile ID cannot be combined with profile attributes.
 */
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
 * Optional fields whose value is `undefined` are omitted from the request.
 *
 * @typeParam Name - A name from the client's event catalog.
 * @typeParam Properties - The property shape selected by `Name`.
 */
export type EventInput<Name extends string, Properties extends JsonObject> = Readonly<{
  name: Name;
  profile: EventProfile;
  properties: Properties;
  time?: Date;
  value?: number;
  valueCurrency?: string;
  uniqueId?: string;
  backfill?: boolean;
}>;

/**
 * Input for an event-backed transactional email flow.
 *
 * Backfilling is intentionally unavailable because transactional email events
 * are always sent with `backfill: false`.
 */
export type TransactionalEmailInput<Name extends string, Properties extends JsonObject> = Omit<
  EventInput<Name, Properties>,
  "backfill"
>;

/**
 * A generated profile resource whose custom `properties` use the
 * consumer-defined shape.
 *
 * The generic describes the expected account schema; profile data is not
 * validated at runtime.
 */
export type KlaviyoProfile<Properties extends JsonObject = JsonObject> = Omit<
  ProfileResponsePluralConversationsObjectResourceExtended,
  "attributes"
> & {
  attributes: Omit<
    ProfileResponsePluralConversationsObjectResourceExtendedAttributes,
    "properties"
  > & { properties?: Properties | null };
};

/**
 * Filtering, cursor pagination, and sorting options passed directly to the
 * Klaviyo reviews API.
 */
export type PullReviewsInput = Readonly<{
  filter?: string;
  pageCursor?: string;
  pageSize?: number;
  sort?: "created" | "-created" | "rating" | "-rating" | "updated" | "-updated";
}>;

/**
 * Creates an event whose property shape is selected by its event name.
 *
 * @remarks A resolved promise means Klaviyo accepted the event for asynchronous
 * processing; it does not guarantee that downstream flows completed.
 *
 * @throws TypeError if the event name or selected profile identifier is empty,
 * or if the event name is 128 characters or longer.
 */
export async function createEvent<
  Events extends EventCatalog,
  ProfileProperties extends JsonObject,
  Name extends keyof Events & string,
>(
  client: KlaviyoClient<Events, ProfileProperties>,
  input: EventInput<Name, Events[Name]>,
): Promise<void> {
  await client.api(EventsApi).createEvent(buildEventQuery(input));
}

function buildEventQuery<Name extends string, Properties extends JsonObject>(
  input: EventInput<Name, Properties>,
): EventCreateQueryV2 {
  assertNonEmpty(input.name, "event name");
  if (input.name.length >= 128) {
    throw new TypeError("event name must be less than 128 characters");
  }
  return {
    data: {
      type: "event",
      attributes: {
        properties: input.properties,
        ...(input.time === undefined ? {} : { time: input.time }),
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.valueCurrency === undefined ? {} : { valueCurrency: input.valueCurrency }),
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
}

/**
 * Triggers an event-backed Klaviyo flow containing transactional email content.
 *
 * The event is always created with `backfill: false`; all validation and
 * asynchronous-acceptance semantics from {@link createEvent} apply.
 */
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

/**
 * Queues an existing Klaviyo marketing campaign for asynchronous sending.
 *
 * @returns The campaign send-job resource returned by Klaviyo.
 * @throws TypeError if `campaignId` is empty.
 */
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

/**
 * Reads a profile by its Klaviyo-generated profile ID.
 *
 * @remarks The client's profile-properties generic is a compile-time contract;
 * the returned custom properties are not validated at runtime.
 * @throws TypeError if `profileId` is empty.
 */
export async function readProfile<
  Events extends EventCatalog,
  ProfileProperties extends JsonObject,
>(
  client: KlaviyoClient<Events, ProfileProperties>,
  input: Readonly<{ profileId: string }>,
): Promise<KlaviyoProfile<ProfileProperties>> {
  assertNonEmpty(input.profileId, "profileId");
  const profile = (await client.api(ProfilesApi).getProfile(input.profileId)).body.data;
  return profile as KlaviyoProfile<ProfileProperties>;
}

/**
 * Reads one filtered and cursor-paginated page of account reviews.
 *
 * @returns Klaviyo's compound collection document, including pagination links
 * and any related resources returned by the API.
 */
export async function pullReviews<
  Events extends EventCatalog,
  ProfileProperties extends JsonObject,
>(
  client: KlaviyoClient<Events, ProfileProperties>,
  input: PullReviewsInput = {},
): Promise<GetReviewResponseDTOCollectionCompoundDocument> {
  return (await client.api(ReviewsApi).getReviews(input)).body;
}

function eventProfileData(profile: EventProfile): EventProfileCreateQueryResourceObject {
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
  identifier: { email: string } | { phoneNumber: string } | { externalId: string },
): EventProfileCreateQueryResourceObject["attributes"] {
  return {
    ...identifier,
    ...(profile.firstName === undefined ? {} : { firstName: profile.firstName }),
    ...(profile.lastName === undefined ? {} : { lastName: profile.lastName }),
    ...(profile.phoneNumber === undefined ? {} : { phoneNumber: profile.phoneNumber }),
    ...(profile.externalId === undefined ? {} : { externalId: profile.externalId }),
    ...(profile.properties === undefined ? {} : { properties: profile.properties }),
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported profile identifier: ${String(value)}`);
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} cannot be empty`);
}
