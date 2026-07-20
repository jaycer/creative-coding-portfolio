---
description: Branch, PR, squash-merge, and confirm the GitHub Pages deploy
---

Ship the current working changes end to end: **branch → commit → PR → squash-merge → auto-deploy → verify live**. Deploy is automated — merging to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages. There is no manual deploy step; the merge *is* the deploy.

Extra instructions from the user (may be empty): $ARGUMENTS

Work through these steps in order. Stop and report if any step fails rather than pushing past it.

1. **Sanity-check state.** `git status` and `git diff --stat`. If there are no changes to ship, say so and stop. If `$ARGUMENTS` names a specific scope, make sure what's staged matches it.

2. **Build locally first.** Run `npm run build`. If it fails, stop and report — never open a PR on a red build.

3. **Decide the PR title carefully — it becomes the changelog line.** Squash-merged PR titles are this repo's release notes (see the release-changelog workflow). Match the existing house style: `Area: what changed and why` (e.g. `Chair Pile: contact-hardened shadows and tighter joinery`). No em dashes. American spelling. If the user gave a title in `$ARGUMENTS`, use it; otherwise derive one from the diff and confirm it reads well as a changelog entry.

4. **Branch, stage, commit.** If already on a non-`main` branch with the changes, reuse it; otherwise `git checkout -b <kebab-title>`. `git add -A`, then commit with the title as the subject, a short body, and the trailer:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

5. **Push — with the buffer already raised.** This project ships binary assets (AVIF photos, images), and a large pack over HTTPS fails with `HTTP 400 / send-pack: unexpected disconnect`. Guard against it before pushing:
   `git config http.postBuffer 524288000`
   Then `git push -u origin <branch>`. If a push still 400s, it's the pack size — retry once; do not force-push (main's ruleset blocks non-fast-forward and the branch ruleset may too).

6. **Open the PR** with `gh pr create --base main`. Title from step 3. Body: a tight bullet summary of the change, ending with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line.

7. **Wait for the PR build check, then squash-merge.** `gh pr checks <n>` — the `build` check must pass (the `deploy` check shows `skipping` on PRs, which is expected; deploy only runs on real pushes to `main`). Once `build` is green: `gh pr merge <n> --squash --delete-branch`.

8. **Watch the real deploy.** The merge pushes `main`, which starts a new run. Find it with `gh run list --branch main --limit 1`, then `gh run watch <id> --exit-status`. Both `build` and `deploy` jobs must go green.

9. **Verify it's actually live.** `curl -s -o /dev/null -w "%{http_code}"` the deployed URL(s) touched by this change under `https://jaycer.github.io/creative-coding-portfolio/` — expect `200`. For a new/renamed sub-app, check its `apps/<slug>/` page plus one asset (an AVIF or the card SVG). GitHub Pages can lag a few seconds after the run finishes; retry once if you get a stale code.

10. **Report** the PR number/URL, that build + deploy went green, and the live URL you confirmed returned 200. Leave `main` checked out and up to date (`git checkout main && git pull`).
