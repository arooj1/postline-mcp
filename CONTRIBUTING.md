# Contributing to postline-mcp

Thanks for helping. A few ground rules keep this project trustworthy:

1. **Official LinkedIn API only.** No scraping, browser automation, cookies or stored passwords. Pull requests that add them will be closed.
2. **Honest scope.** If LinkedIn's self-serve API doesn't allow something, say so in the README rather than working around it.
3. **Nothing publishes without the user's OK.** New tools that change LinkedIn must be annotated as such and described so Claude confirms first.

## Getting started

```bash
git clone https://github.com/arooj1/postline-mcp && cd postline-mcp
npm install
npm run check        # type-check + unit tests; CI runs the same
```

To run the Worker locally, see **Develop** in the README. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the files fit together.

## Pull requests

- Keep each PR to one change, with a short description of *why*.
- Add or update tests in `test/`. LinkedIn calls are tested with the fake `fetch` in `test/helpers.ts`; never call the real API from tests.
- If you change how postline talks to LinkedIn, say whether you verified it against the live API, and how.
- CI must pass. It runs on every pull request and never deploys from forks.

## Reporting problems

- **Bugs and ideas:** open an issue with what you did, what you expected, and what happened (redact tokens and member IDs).
- **Security issues:** don't open a public issue; see [SECURITY.md](SECURITY.md).

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
