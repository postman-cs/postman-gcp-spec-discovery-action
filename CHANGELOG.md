# Changelog

## v1.0.0

Initial release.

- Zero-config GCP spec discovery for Postman onboarding across API Gateway configs, Cloud Endpoints configs, Apigee proxies and portal sites, API Hub specs, Application Integration OpenAPI generation, Integration Connectors custom specs, Vertex AI extensions, Dialogflow tools, CES apps/toolsets/tools, repo-local specs, and repo-local GCP IaC extraction.
- Repo-spec short-circuit, four-tier narrowing pipeline, ranked ambiguity Step Summary, and confidence-scored resolution.
- GitHub Action (`dist/index.cjs`) and portable CLI (`dist/cli.cjs`) over one shared runtime with 22 locked outputs and dotenv export.
- Anonymous single-event telemetry (`gcp-spec-discovery`) with strict payload hygiene and opt-out.
