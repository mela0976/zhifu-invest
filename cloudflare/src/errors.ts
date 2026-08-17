const APP_ERROR_STATUSES: Readonly<Record<string, number>> = {
  admin_identity_invalid: 403,
  admin_two_factor_invalid: 403,
  approval_required: 409,
  apps_script_http_error: 502,
  apps_script_invalid_response: 502,
  apps_script_not_configured: 503,
  apps_script_unavailable: 502,
  configuration_error: 503,
  consent_required: 409,
  corrupt_data: 502,
  forbidden: 403,
  identity_not_linked: 403,
  invalid_amount: 409,
  invalid_amounts: 409,
  invalid_qualification_expiry: 409,
  invalid_request: 400,
  invalid_state: 400,
  invalid_transition: 409,
  line_push_failed: 502,
  not_found: 404,
  rate_limited: 429,
  replayed_envelope: 502,
  risk_acknowledgement_required: 409,
  seed_requires_empty_workbook: 409,
  state_amount_mismatch: 409,
  unknown_operation: 502,
  validation_error: 400,
};

export function appsScriptErrorStatus(code: string): number {
  const normalized = code.trim().toLowerCase();
  const exact = APP_ERROR_STATUSES[normalized];
  if (exact) return exact;
  if (normalized.endsWith('_not_found')) return 404;
  if (normalized.includes('forbidden') || normalized.includes('unauthorized')) return 403;
  if (normalized.includes('conflict')) return 409;
  if (normalized.includes('rate_limit')) return 429;
  if (normalized.startsWith('validation_')) return 400;
  return 502;
}
