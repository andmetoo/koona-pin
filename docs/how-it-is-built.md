# How Koona Pin is built

Koona Pin has one maintainer. Most of the code, tests and documentation are written by AI coding agents working on tasks the maintainer defines, reviews and merges. This page describes that process as it is.

## Roles

The maintainer owns the product: what to build, the design, priorities and acceptance. An agent gets a bounded task, implements it and brings back a result that can be checked. Passing tests and an agent's own approval do not replace the maintainer checking the app.

Agents work in a few modes, not all at once:

| Mode | Does | Stays with the maintainer |
| --- | --- | --- |
| Product analysis | Writes the scenario, criteria, edge cases | Who it is for, value, priority |
| Implementer | Makes one bounded change and runs the checks | Any decision to widen the scope |
| Reviewer | Looks for defects in the diff and the behaviour, reproduces them | How serious a finding is; acceptance |
| Release helper | Prepares packages, checklists and release notes | Public announcements and publishing |

By default one task is in implementation at a time. A second agent may review finished work or research something in parallel. Parallel code changes happen only when the contracts are agreed and the files do not overlap; each implementer works in its own branch and worktree, and one person integrates.

## Tasks

Work is tracked as GitHub issues and moves through Backlog → Ready → In progress → Review → Done. A task is a small, complete user scenario that the maintainer can accept carefully in one sitting.

A task is ready when it states:

- the problem: who, in what situation, what does not work;
- the expected behaviour as a short scenario;
- the sources: design frames, related documents and contracts;
- what is in scope and what is explicitly out;
- data concerns: migrations, old records, failed writes, recovery;
- numbered acceptance criteria, each an observable result ("when …, the person does … and sees …"), including behaviour on errors and after a restart;
- how it will be checked.

Empty fields mean planning is unfinished, not that the agent may invent the product. Agents are told to report contradictions in the sources before implementing, to keep user data and existing changes safe, not to add dependencies or features the task does not justify, and never to change designs or test baselines to hide a mismatch.

## One branch and one pull request per task

Each task gets its own branch and pull request. A pull request that changes the app (`src`, `src-tauri`) raises the app version in the same change: minor for a feature or a new database schema, patch for a fix. The number lives in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`. A change under `extension/src` raises the extension's own version in `extension/src/version.js`. This way any two builds that reach testers differ by number.

## Checks before merge

The implementer runs the checks that match the risk of the change ([testing.md](testing.md)): `bun run check` always, plus the UI, native, extension or Linux checks when those areas change. The report back must say what the person can now do, which files changed, which checks ran, what was not checked, and which decisions need the maintainer. "Done" without that evidence is not accepted.

A task is finished when:

- the criteria hold in a working scenario;
- data is not lost, errors are understandable, undo works where it is promised;
- the checks pass;
- changed UI matches the current design in both themes and works from the keyboard;
- review findings are resolved;
- the documentation describes the behaviour and its limits;
- the change is on `main` and reproducible.

## Independent review

Review is a separate pass, preferably by an agent with a fresh context that gets the task, the diff, the requirements and the test results, without being asked to confirm the author's view. It starts with the risk of data loss, contract mismatches and behaviour on errors; each finding names the condition, the effect, the file and how to check it, and confirmed defects are kept apart from suspicions. No findings is not treated as proof of no defects.

## Decision records

Choices with lasting consequences are written down as records: context, two or three realistic options, the decision and why, consequences, how it was verified, and what would make it worth revisiting. Each notes who chose: product choices are the maintainer's; technical proposals by an agent are accepted through the maintainer's review. The full records are kept privately; [decisions.md](decisions.md) summarises the technical ones.

## The maintainer merges

The maintainer reads the diff and the report, runs the scenario in the app, and either merges or sends the task back with concrete remarks. Agents do not merge, publish or speak for the project on their own. Release builds are signed by the maintainer.

## Rhythm

- A week has one target result, two to four small tasks, the main risk and a demo criterion. Estimates are rough, not promises.
- While an agent works on one task, the maintainer reviews the previous one or prepares the next.
- Time is kept for defects and releases.

What is watched: the time from a ready task to acceptance, defects after a release, whether "save and find it again" works, and whether a library can always be restored. Progress is not measured in lines of code, tokens or the number of agents running.
