# Documentation

| Document | Read it if you are |
|---|---|
| [ptz-controller-firmware-spec.md](ptz-controller-firmware-spec.md) | writing the PTZ controller firmware (ESP32). Self-contained: every message, the behavior of each command, tests |
| [rposascii-protocol-v2.md](rposascii-protocol-v2.md) | working on rpos, or want the design reasons behind the protocol. Includes the rpos implementation status and config keys |
| [frigate-autotracking-analysis.md](frigate-autotracking-analysis.md) | wondering what Frigate autotracking needs and what was missing in rpos |
| [frigate-autotracking-plan.md](frigate-autotracking-plan.md) | following the plan and its status |
| [ptz-bug-fix-plan.md](ptz-bug-fix-plan.md) | looking at the PTZ bugs that were found, and which are fixed |

`firmware/` has the tested sample code for the firmware: a line parser
(`rposascii_parse.h`, with `parser_test.cpp`) and a command-line probe
(`probe.py`) to talk to a controller by serial or TCP.
