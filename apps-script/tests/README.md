# Apps Script tests

These tests load the pure `.gs` rules into Node's VM and use Node Crypto as an
independent HMAC oracle. They do not access a real Google Sheet or LINE account.

```bash
node apps-script/tests/run-tests.cjs
```

Live acceptance still requires both Apps Script deployments, a test Google
account in `ADMIN_EMAILS`, a real LINE test user, and a test R2 deck object.
