# Validation Evidence

`live-gcp-surfaces.json` is the sanitized schema-1 summary for GCP live validation. It contains only totals and per-case `{name, status, sourceType, providerType, specFormat}`. Project identifiers, service names, URLs, spec bodies, tokens, and command output must not be committed.

The committed summary reflects the latest credentialed live run; rerun the script to refresh it.

Cases cover explicit and discovered API Gateway configs, explicit and discovered Cloud Endpoints configs, an Apigee proxy with embedded OAS, discover-many, a local Terraform path reference, and local ambiguity.

Run after building and authenticating gcloud ADC:

```sh
GCP_PROJECT_ID=<project> node validation/scripts/validate-live-gcp-surfaces.mjs --provision --teardown
```

The runner creates collision-resistant resources and tears down only exact current-run Gateway, Endpoints, and Apigee proxy names whose markers match. Shared Apigee organization, environment, and environment group resources are never deleted.
