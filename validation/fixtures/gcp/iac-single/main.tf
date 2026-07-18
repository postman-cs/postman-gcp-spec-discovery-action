resource "google_api_gateway_api" "live" {
  provider = google-beta
  api_id   = "postman-live-api"
}

resource "google_api_gateway_api_config" "live" {
  provider      = google-beta
  api           = google_api_gateway_api.live.api_id
  api_config_id = "postman-live-config"
  openapi_documents {
    document {
      path     = "openapi.yaml"
      contents = filebase64("${path.module}/openapi.yaml")
    }
  }
}
