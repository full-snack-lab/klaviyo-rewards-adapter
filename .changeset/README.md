# Release changesets

Add a changeset for consumer-visible changes to `@fullsnacklab/klaviyo-rewards-adapter`.

```sh
bunx changeset
```

Apply pending versions and publish manually with:

```sh
bunx changeset version
bun install
bun publish
```

`bun publish` builds the package through `prepublishOnly` before publishing it to npm.
