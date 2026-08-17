# credentials/

Local store for essential project credentials (API keys, tokens, service
accounts, deploy secrets).

## Security rules

- **This directory is git-ignored.** Real secret files NEVER get committed.
- Only two things are tracked in git: this `README.md` and any `*.example.*`
  template files. Everything else here stays local to your machine.
- Never paste a real secret into a `.example` file or into chat/commits.
- If a secret is ever committed by accident, rotate it immediately — removing
  it from a later commit does not remove it from git history.

## Usage

1. Copy a template and fill in real values:

   ```
   cp credentials/credentials.example.json credentials/credentials.json
   ```

2. Reference `credentials/credentials.json` from your app/scripts. Keep the
   real file out of source control (it already is, via `.gitignore`).

## What goes where

| File                         | Tracked? | Purpose                          |
|------------------------------|----------|----------------------------------|
| `README.md`                  | yes      | This doc                         |
| `credentials.example.json`   | yes      | Template showing required keys   |
| `credentials.json`           | no       | Your real secrets (git-ignored)  |
| `*.key`, `*.pem`, `.env*`    | no       | Any other real secret material   |
