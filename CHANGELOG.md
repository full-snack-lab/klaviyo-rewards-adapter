# @fullsnacklab/klaviyo-rewards-adapter

## 0.4.1

### Patch Changes

- 1b58fba: Fix npm releases to include the compiled JavaScript and TypeScript declaration files.

## 0.4.0

### Minor Changes

- 49220a4: Introduced bunup.config.ts for build configuration Added changeset configuration for managing versioning and changelogs. Improved code formatting and organization across various source files.

## 0.3.0

- Initial public release with OAuth support for multiple Klaviyo accounts.
- Adds a `TokenStore` interface for encrypted token storage with distributed locking.
- Integrates typed events and Infisical secrets with official `klaviyo-api` SDK.
- Requires Node.js 22+.
- Refer to [README.md](./README.md) and [USAGE.md](./USAGE.md) for setup and usage instructions.
