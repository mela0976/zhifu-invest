/** Signed Cloudflare Worker -> Apps Script gateway. */

var ZF_GATEWAY_WINDOW_MS = 5 * 60 * 1000;

function canonicalEnvelopeString_(envelope) {
  return [
    String(envelope.timestamp),
    String(envelope.nonce),
    String(envelope.operation),
    String(envelope.payloadJson)
  ].join('\n');
}

function computeGatewaySignature_(envelope, secret) {
  var bytes = Utilities.computeHmacSha256Signature(
    canonicalEnvelopeString_(envelope),
    secret,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64Encode(bytes);
}

function constantTimeEqual_(left, right) {
  left = String(left || '');
  right = String(right || '');
  var difference = left.length ^ right.length;
  var length = Math.max(left.length, right.length);
  for (var index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index % (left.length || 1)) || 0) ^
      (right.charCodeAt(index % (right.length || 1)) || 0);
  }
  return difference === 0;
}

function verifyGatewayEnvelope_(envelope, secret, currentTimeMs) {
  if (!envelope || typeof envelope !== 'object') {
    throw domainError_('JSON envelope is required', 'invalid_envelope');
  }
  ['nonce', 'operation', 'payloadJson', 'signature'].forEach(function (field) {
    if (typeof envelope[field] !== 'string' || !envelope[field]) {
      throw domainError_('Envelope field ' + field + ' is required', 'invalid_envelope');
    }
  });
  if ((typeof envelope.timestamp !== 'string' && typeof envelope.timestamp !== 'number') ||
      !String(envelope.timestamp)) {
    throw domainError_('Envelope field timestamp is required', 'invalid_envelope');
  }
  if (!/^\d{13}$/.test(envelope.timestamp)) {
    throw domainError_('timestamp must be Unix epoch milliseconds', 'invalid_timestamp');
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(envelope.nonce)) {
    throw domainError_('nonce format is invalid', 'invalid_nonce');
  }
  if (!/^[A-Za-z][A-Za-z0-9.]{1,95}$/.test(envelope.operation)) {
    throw domainError_('operation format is invalid', 'invalid_operation');
  }
  var timestamp = Number(envelope.timestamp);
  var nowMs = currentTimeMs === undefined ? Date.now() : currentTimeMs;
  if (Math.abs(nowMs - timestamp) > ZF_GATEWAY_WINDOW_MS) {
    throw domainError_('Gateway envelope has expired', 'expired_envelope', 401);
  }
  var expected = computeGatewaySignature_(envelope, secret);
  if (!constantTimeEqual_(expected, envelope.signature)) {
    throw domainError_('Gateway signature is invalid', 'invalid_signature', 401);
  }
  var payload;
  try {
    payload = JSON.parse(envelope.payloadJson);
  } catch (error) {
    throw domainError_('payloadJson is invalid JSON', 'invalid_payload');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw domainError_('payloadJson must contain a JSON object', 'invalid_payload');
  }
  return payload;
}

function assertAndStoreNonce_(envelope) {
  var sheet = sheet_('GatewayNonces');
  var nowMs = Date.now();
  var rows = storeList_('GatewayNonces');
  var expiredRowNumbers = [];
  rows.forEach(function (row, index) {
    if (row.nonce === envelope.nonce) {
      throw domainError_('Gateway nonce was already used', 'replayed_envelope', 409);
    }
    if (nowMs - Number(row.timestamp) > 24 * 60 * 60 * 1000) {
      expiredRowNumbers.push(index + 2);
    }
  });
  expiredRowNumbers.reverse().forEach(function (rowNumber) {
    sheet.deleteRow(rowNumber);
  });
  sheet.appendRow([
    envelope.nonce,
    envelope.timestamp,
    envelope.operation,
    nowIso_()
  ]);
}
