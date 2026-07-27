# Security Policy

## Report vulnerabilities privately

Do not open a public issue for a vulnerability, credential exposure, authorization bypass, privacy leak, payment flaw, sandbox escape, or provider-account risk.

Use a [private GitHub security advisory](https://github.com/richkapp/challenge-my-ai/security/advisories/new). Include:

- affected route/package/commit;
- impact and realistic attack path;
- reproduction steps or a minimal proof;
- whether production data, credentials, provider spend, or user privacy may be affected;
- a proposed fix, if you have one.

Please do not test against production users, trigger paid provider calls, access data that is not yours, or publish exploit details before a fix is available.

## Security model

Challenge text, URLs, pasted model output, and generated code are hostile data. The application must not treat them as instructions to execute code, fetch arbitrary links, install packages, access tools, or expose secrets.

A paired local Agent submission proves that a paired client submitted a card. It does not prove an untampered machine or provider-signed model identity.

## Supported code

Security fixes target the current `main` branch. Historical snapshots and experimental branches are not supported release lines.
