# Privacy Engine — M0 Foundation

Privacy-first PII detection and redaction that runs entirely on-device.

## M0 Status

No functionality yet. Module scaffolded for later development.

## Planned features

1. Local text scanning for personal information (emails, phone numbers, addresses)
2. DOM-based PII detection
3. Screen content classification
4. Redaction / masking utilities
5. On-device hash-based fingerprinting prevention

## Development notes

- All processing happens in the browser — no network calls
- Use native JavaScript + regex + DOM APIs first
- Consider adding lightweight regex-based scanners before ML models
- Results fed into `vision/` and `extension/` pipelines