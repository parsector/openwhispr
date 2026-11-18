# Fork-owned model catalog

Edit **`src/models/modelRegistryData.json`** to add or change a model, then run
`npm run model-registry:sync` and `npm run model-registry:verify`. The first
command regenerates local integrity metadata; the second checks catalog shape,
reader/catalog hashes and artifact publisher trust entirely offline. Review
these edits as application code. No vendor signing key, publication, remote
release approval, retirement flag, minimum app version or plan controls the
choices shipped by this fork. Download URLs, artifact hashes and download trust
checks remain in force. A new publisher requires an explicit fork trust edit in
`src/helpers/registryDownloadTrust.js`.

Main bootstraps the bundled catalog and its exact local cache/backup. A cache
with different entries, even a valid old vendor publication, cannot override
the build. Pickers and routing share `registryData.js` / `ModelRegistry.ts`.
Installed model metadata still restores missing local artifact descriptions
through the existing trust checks. A missing saved model remains saved and is
shown by ID with an unavailable notice; inference can report an ordinary
missing-model error. Downloading a different local model never replaces a
nonempty saved choice. The user explicitly selects a replacement.

Tinfoil discovery adds models to the fork list; omissions cannot remove shipped
entries or change saved IDs. OpenRouter's shortlist ranks suggestions while the
full discovered list remains selectable and saved IDs stay visible. Provider
memory retains unlisted saved IDs across switches. Actual managed device policy
still applies; lifecycle metadata cannot establish management or a plan gate.

The previous retirement reconciliation exports remain inert compatibility
seams for existing callers. They perform no storage writes or model switches.
Canary scripts probe this same build catalog; `--published` is unsupported.
