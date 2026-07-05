# Security Policy

The launcher handles sensitive material: it generates validator consensus
keys, node keys, and account mnemonics; it holds an ephemeral SSH keypair
with root access to the chain nodes it configures, and an Akash mTLS client
certificate. Security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report
vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repo's Security tab).

You can expect an acknowledgement within 72 hours. Please include steps to
reproduce and an assessment of impact if you have one.

## Scope notes

- The launcher never holds wallet keys or funds — all Akash transactions are
  signed by the user's browser wallet (Keplr).
- Secrets at rest (SSH key, mTLS cert, generated chain keys) are encrypted in
  the launcher's local state database; see `docs/DESIGN.md` §2–3 for the
  custody model and the threat-model differences between running the launcher
  locally vs. on Akash.
- Running the launcher on an Akash provider places launch-time secrets on
  untrusted infrastructure. This is documented and warned about in the UI;
  it is not considered a vulnerability. Mainnet launches should use local
  mode and an external signer (TMKMS).
