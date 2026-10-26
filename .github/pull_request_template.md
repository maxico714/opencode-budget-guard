## What changed

<!-- One paragraph: the failure you observed and the fix. -->

## How it was verified

- [ ] `npm run check` passes locally (build, types, lint, format, tests)
- [ ] New or changed behaviour has a test that failed before the change
- [ ] For detector/budget changes: mutation check described below (break it, see the test fail, restore)

Commands and results:

```console
$ npm run check
```

## Checklist

- [ ] Reports and logs still contain no prompts, message bodies or tool output
- [ ] README / docs / CHANGELOG updated when behaviour, defaults or limits changed
- [ ] No new runtime dependencies
- [ ] No TODO/FIXME left in `src/`
