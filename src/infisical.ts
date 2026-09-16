import { InfisicalSDK } from "@infisical/sdk";
import type { OAuthCredentials } from "./client.ts";

/**
 * Configures Universal Auth and typed secret aliases for Infisical.
 *
 * @typeParam Secrets - Maps local aliases to Infisical secret names.
 */
export type InfisicalSecretsOptions<
	Secrets extends Readonly<Record<string, string>>,
> = Readonly<{
	universalAuth: Readonly<{ clientId: string; clientSecret: string }>;
	projectId: string;
	environment: string;
	secrets: Secrets;
	secretPath?: string;
	siteUrl?: string;
}>;

/** A type-safe function that retrieves a configured Infisical secret alias. */
export type InfisicalSecretGetter<
	Secrets extends Readonly<Record<string, string>>,
> = <Name extends keyof Secrets & string>(name: Name) => Promise<string>;

/** Authenticates with Infisical Universal Auth and creates a typed secret getter. */
export async function createInfisicalSecrets<
	const Secrets extends Readonly<Record<string, string>>,
>(
	options: InfisicalSecretsOptions<Secrets>,
): Promise<InfisicalSecretGetter<Secrets>> {
	const sdk = new InfisicalSDK(
		options.siteUrl === undefined ? undefined : { siteUrl: options.siteUrl },
	);
	const client = await sdk.auth().universalAuth.login(options.universalAuth);
	return async (name) => {
		const secretName = options.secrets[name];
		if (!secretName)
			throw new TypeError(`No Infisical secret is mapped for ${name}`);
		return (
			await client.secrets().getSecret({
				projectId: options.projectId,
				environment: options.environment,
				secretPath: options.secretPath ?? "/",
				secretName,
			})
		).secretValue;
	};
}

/** Resolves Klaviyo OAuth credentials from two typed Infisical aliases. */
export async function oauthCredentialsFromInfisical<
	Secrets extends Readonly<Record<string, string>>,
>(
	getSecret: InfisicalSecretGetter<Secrets>,
	names: Readonly<{
		clientId: keyof Secrets & string;
		clientSecret: keyof Secrets & string;
	}>,
): Promise<OAuthCredentials> {
	const [clientId, clientSecret] = await Promise.all([
		getSecret(names.clientId),
		getSecret(names.clientSecret),
	]);
	return { clientId, clientSecret };
}
