# Bombadil trial

Local run of Bombadil 0.8.0 against `bun src/main.ts`. The binary was `.scratch/bombadil`. The specification is `bombadil/cli.spec.ts`. This run is not a CI gate. `scripts/fuzz-bombadil.sh` uses a temp `HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME`, copies `examples/zwt.toml`, and passes `--dry-run` plus that copy on the wizard campaign.

## Properties

The specification exports `noReplacementChars` and `typeBasicInput` from Bombadil's terminal defaults. It does not export `exitSuccess`. Four properties are local.

- `noReplacementChars` fails when the screen contains U+FFFD.
- `helpShapedExitsZero` fails when the screen contains `USAGE`, does not contain `ERROR` or `Command wizard`, and the process has exited with a code other than 0. That shape is requested help: `--help`, or the same usage text with no error section.
- `usageErrorExitsOne` fails when the screen contains `USAGE` and `ERROR`, does not contain `Command wizard`, and the process has exited with a code other than 1. That shape is Effect's usage failure, such as an unknown flag or subcommand.
- `noUnhandledDefect` fails when the screen contains `Defect`, `Unhandled exception`, or a Node stack frame (`at ... (`). A domain error printed as `error:` and `fix:` stays allowed.
- `exitZeroOrOne` allows a still-running process, exit 0, and exit 1.

`ERROR` is the Effect usage-error section header. The help text's lowercase `error` log-level choice does not match it. The CLI exit codes were not changed.

## Campaigns

Each campaign is `bombadil terminal fuzz` with `--time-limit-run 5s`. The fuzz limits are 45s and 45s. The script's wall time on this machine was 91.3 seconds. Both campaigns printed `Fuzzing finished after time limit`.

| Campaign | Command | Runs | Violations | Process exit |
| --- | --- | --- | --- | --- |
| help | `bun src/main.ts --help` | 44 | 0 | 0 |
| wizard | `bun src/main.ts --dry-run --wizard --config` and a temp copy of `examples/zwt.toml` | 36 | 21 of 36, property `helpShapedExitsZero` | 2 |

The help campaign's status frames left SPS, time, and action blank, so this note has no samples-per-second figure for it. The count Bombadil printed is 44 runs and 0 violations. The wizard campaign's last action frame printed SPS 104.9 at 1.157 seconds into run 35, action `Typing "\r"`. That SPS value is the gauge on that frame. The campaign result is the printed line `finding violations in 21 of 36 runs`.

The help campaign completed 44 runs in the same 45s limit where the wizard campaign completed 36. The wizard frames were still inside a run at 1.157 seconds. The per-run cap in the script is 5s.

A separate `bombadil terminal test --time-limit 12s` of `bun src/main.ts --help` printed `Throughput (state samples/sec): 1.0` and `Exited as process terminated with exit code 0`. That run stopped because the process exited, after one sample. It is not the fuzz campaign rate.

## Violation

The original wizard campaign's violation list named only `helpShapedExitsZero`. The help campaign printed `no violations in 44 runs`.

A later 20s wizard fuzz, same command and specification, was used only to read a trace. It printed `finding violations in 14 of 16 runs`, again only `helpShapedExitsZero`. Trace `wizard-0` ends at exit code 1. The screen contains `USAGE` and the subcommand list. It does not contain `Command wizard`. The last action is typing enter. Scroll offset is 61. That screen is Effect's usage help. Usage failures already exit 1, and `exitZeroOrOne` did not fire. The property at that time treated any `USAGE` screen without `Command wizard` as requested help and asked it to exit 0.

The specification now splits those screens. `USAGE` without `ERROR` still has to exit 0 (`helpShapedExitsZero`). `USAGE` plus `ERROR` has to exit 1 (`usageErrorExitsOne`). Those 21 wizard findings would no longer trip `helpShapedExitsZero`.

Direct checks of `bun src/main.ts` on this machine, 23 November 2026 (America/Santiago):

| Invocation | Screen | Exit |
| --- | --- | --- |
| `--help` | `USAGE`, no `ERROR` | 0 |
| no arguments | `USAGE`, no `ERROR` | 0 |
| `--not-a-real-flag` | `USAGE` and `ERROR` (`Unrecognized flag`) | 1 |
| `notacommand` | `USAGE` and `ERROR` (`Unknown subcommand`) | 1 |

`bombadil` was not on `PATH`, `BOMBADIL` was unset, and there was no `.scratch/bombadil` binary in the worktree or the main checkout. `scripts/fuzz-bombadil.sh` would exit 1 with the missing-binary message. The wizard campaign was not re-run.

## What limits the numbers

Both 45s campaigns stopped on the fuzz time limit, which is the line Bombadil printed. Each campaign ran once, so there is no second trial to compare. A longer limit would add runs. It would not change the usage-error exit already recorded in the traces. The 104.9 SPS reading is one frame during typing, bounded by how often Bombadil samples that run, not by how many wizard runs finished in 45s.
