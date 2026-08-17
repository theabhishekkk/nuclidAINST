# Commit Convention

All commits in this repo follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
The convention is **enforced automatically** by a husky `commit-msg` hook that runs
[commitlint](https://commitlint.js.org/) (`@commitlint/config-conventional`) on every commit —
a non-conforming message is rejected before the commit lands.

## Header format

```
<type>(<optional scope>): <subject>
```

- **type** — required, lower-case, one of the types below.
- **scope** — optional, free-form (e.g. `parser`, `calibration`, `ui`). Parentheses only when present.
- **subject** — required, short imperative summary.

Examples: `feat(calibration): add quadratic fit model`, `fix: guard against empty spectrum`.

## Types

| Type       | Use for                                            |
| ---------- | -------------------------------------------------- |
| `feat`     | a new feature                                      |
| `fix`      | a bug fix                                           |
| `docs`     | documentation only                                 |
| `style`    | formatting; no code-behavior change                |
| `refactor` | neither fixes a bug nor adds a feature             |
| `perf`     | a performance improvement                          |
| `test`     | adding or fixing tests                             |
| `build`    | build system or dependencies                       |
| `ci`       | CI configuration                                   |
| `chore`    | other changes that don't touch src or tests        |
| `revert`   | reverts a previous commit                          |

## The seven rules (subject & body)

Based on Chris Beams' [seven rules of a great commit message](https://cbea.ms/git-commit/):

1. Separate subject from body with a blank line.
2. Limit the subject line to ~50 characters.
3. Capitalize the subject line (after the `type(scope): ` prefix).
4. Do not end the subject line with a period.
5. Use the imperative mood in the subject ("add", not "added"/"adds").
6. Wrap the body at 72 characters.
7. Use the body to explain **what** and **why**, not how.

> Note: the ~50-char subject and 72-char body wrap are guidance (in this doc and the
> `.gitmessage` template), not hard-enforced by commitlint today. commitlint enforces a
> valid type, a non-empty subject, a lower-case type, the blank line before the body, and
> the default header-length cap. See "Open choices" in the setup hand-off if you want the
> 50-char subject enforced.

## Breaking changes

Signal a breaking change in either of two ways:

- Append `!` after the type/scope: `feat(api)!: drop legacy calibration format`
- Add a `BREAKING CHANGE:` footer describing the break:

```
feat(api): replace calibration payload shape

BREAKING CHANGE: `coefficients` is now an array of {model, terms}
objects instead of a flat number[]. Stored calibrations must be
re-saved.
```

## Worked examples

A simple feature:

```
feat(peaks): add significance classification to fitted peaks
```

A fix with a body explaining what and why:

```
fix(fit): reject Gaussian hops beyond the search window

The fitter occasionally latched onto a neighbouring peak when the
seed centroid was near a window edge, producing a centroid error
larger than the window itself. Clamp the accepted centroid to the
search window and fail loud otherwise.
```

A breaking change:

```
refactor(calibration)!: return both linear and quadratic models

BREAKING CHANGE: calibrate() now returns a dual-model result
({ linear, quadratic, defaultModel }) instead of a single model.
Callers must select a model via `result[result.defaultModel]`.
```
