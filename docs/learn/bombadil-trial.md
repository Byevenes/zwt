# Bombadil trial

Local run of Bombadil 0.8.0 against `bun src/main.ts`. The binary was `.scratch/bombadil`. The specification is `bombadil/cli.spec.ts`. This run is not a CI gate. `scripts/fuzz-bombadil.sh` uses a temp `HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME`, copies `examples/zwt.toml`, and passes `--dry-run` plus that copy on the wizard campaign.

## Properties

The specification exports `noReplacementChars` and `typeBasicInput` from Bombadil's terminal defaults. It does not export `exitSuccess`. Three properties are local.

- `noReplacementChars` fails when the screen contains U+FFFD.
- `helpShapedExitsZero` fails when the screen contains `USAGE`, does not contain `Command wizard`, and the process has exited with a code other than 0.
- `noUnhandledDefect` fails when the screen contains `Defect`, `Unhandled exception`, or a Node stack frame (`at ... (`). A domain error printed as `error:` and `fix:` stays allowed.
- `exitZeroOrOne` allows a still-running process, exit 0, and exit 1.

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

The wizard campaign's violation list names only `helpShapedExitsZero`. The help campaign printed `no violations in 44 runs`.

A later 20s wizard fuzz, same command and specification, was used only to read a trace. It printed `finding violations in 14 of 16 runs`, again only `helpShapedExitsZero`. Trace `wizard-0` ends at exit code 1. The screen contains `USAGE` and the subcommand list. It does not contain `Command wizard`. The last action is typing enter. Scroll offset is 61. That screen is Effect's usage help. Usage failures already exit 1, and `exitZeroOrOne` did not fire. The property asks that same help text to exit 0. This note records the disagreement. The exit code and the property stay as they are.

## What limits the numbers

Both 45s campaigns stopped on the fuzz time limit, which is the line Bombadil printed. Each campaign ran once, so there is no second trial to compare. A longer limit would add runs. It would not change the usage-help exit that `helpShapedExitsZero` flags. The 104.9 SPS reading is one frame during typing, bounded by how often Bombadil samples that run, not by how many wizard runs finished in 45s.
