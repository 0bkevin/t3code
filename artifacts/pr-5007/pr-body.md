## What Changed

- Gives threads auto-settled by a merged pull request a distinct violet banner and merge icon.
- Changes the title to “Pull request merged” and explains why the thread settled.
- Keeps the existing blue settled banner for manual settlements and other settled states.
- Adds focused coverage for settlement classification and merged-banner styling.

## Why

The generic “This thread is settled” banner made a completed merge look like a warning and did not explain why the thread moved out of Active. Violet matches the existing merged pull request indicators and makes the final state visually distinct without changing settlement behavior.

## UI Changes

### Before

The generic blue “This thread is settled” banner. See `before.png` attached in the Discord implementation thread.

### After

The violet “Pull request merged” banner. See `after.png` attached in the Discord implementation thread.

## Checklist

- [x] This PR is small and focused
- [x] I explained what changed and why
- [x] I included before/after screenshots for any UI changes
- [x] I included a video for animation/interaction changes (not applicable, no motion or interaction changed)

## Testing

- Web unit suite: 190 files and 1,695 tests passed
- Web typecheck
- Web production build
- Targeted lint and formatting checks

<!-- t3bot-job:9b2555c8-017c-4aa5-aa52-e384be34c2dc -->
