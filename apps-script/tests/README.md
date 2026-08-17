# Apps Script tests

These tests load the pure `.gs` rules into Node's VM and use Node Crypto as an
independent HMAC oracle. They do not access a real Google Sheet or LINE account.

```bash
node apps-script/tests/run-tests.cjs
```

Live acceptance still requires both fixed-version deployments from the same Apps
Script project, two configured `ADMIN_EMAILS` accounts with TOTP, a real LINE test
user that is an OA friend, and a test R2 deck object.
