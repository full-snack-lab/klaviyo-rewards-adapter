import { InfisicalSDK } from "@infisical/sdk";
import type { OAuthCredentials } from "./client.ts";

/**
 * Configures Infisical Universal Auth and typed local secret aliases.
 *
 * `secretPath` defaults to `/`, and `siteUrl` defaults to Infisical Cloud.
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

/**
 * Retrieves the current value for a configured Infisical secret alias.
 *
 * Values are fetched on every call rather than cached.
 */
export type InfisicalSecretGetter<
	Secrets extends Readonly<Record<string, string>>,
> = <Name extends keyof Secrets & string>(name: Name) => Promise<string>;

/**
 * Authenticates with Infisical Universal Auth and creates a typed secret getter.
 *
 * @remarks Authentication happens once. Each call to the returned getter reads
 * the named secret from Infisical using the configured project, environment,
 * and path.
 *
 * @throws TypeError if a requested alias has no runtime mapping.
 */
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

/**
 * Resolves Klaviyo OAuth credentials from two typed Infisical aliases.
 *
 * Both secrets are requested concurrently. Errors from either lookup are
 * propagated to the caller.
 */
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
