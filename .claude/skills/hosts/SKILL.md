---
name: hosts
description: Launch the gaffer's or the builder's own TSF locally or on a persistent exe.dev VM, redeploy it, or check it. Use when the user asks to start, launch, deploy, redeploy or check the gaffer or builder TSF, put either one on a VM, add a VM's deploy key, or store the board token on the gaffer VM.
argument-hint: "[gaffer|builder] [local|launch|key|token|status] [vm] [builder-vm|owner/repo]"
---

# Purpose

Run the gaffer's or the builder's TSF where the user asks: locally or on its own exe.dev VM.

## Variables

* ARGUMENTS: $ARGUMENTS

## Instructions

- `docs/hosting.md` is the source of truth: layout, network, feature map and curtailed features. Read it before acting.
- Each system folder (`gaffer/`, `builder/`) is its own TSF project. Run its TSF only through `just gaffer tsf …` or `just builder tsf …` locally, and only through `just gaffer vm …` or `just builder vm …` for a VM.
- **Never use `just gaffer tsf push` or `just builder tsf push`.** The tsf skill's push copies the whole repository to one VM: both systems and any local `tsf/data`, including the local gaffer's board token.
- Launch the builder VM before the gaffer VM: the gaffer's launch needs the builder VM's tailnet name.
- Never print the board token or any key value. `vm token` sends the token on stdin.
- Do not change the contract, `gaffer/kit/templates/build-kit/gaffer.ts` or `builder/server.ts` from this skill.

## Workflow

1. Work out the system (`gaffer` or `builder`), the action and the names from ARGUMENTS. When the system is missing and the action is `launch`, do both: builder first, then gaffer.
2. Run the action from the repository root:

   | Action | Command |
   |---|---|
   | local | `av just <system> tsf start --port <8013 for gaffer, 8012 for builder>` in the background; wait for `TSF running at` |
   | launch | `just builder vm launch <vm>` or `just gaffer vm launch <vm> <builder-vm>`, in the background (the first launch takes several minutes). It also redeploys an existing VM and keeps its TSF data |
   | key | `just <system> vm key <vm> <owner/repo>`: read-only for the builder, write access for the gaffer |
   | token | `just gaffer vm token <vm>` |
   | status | `ssh <vm>.exe.xyz 'curl -s http://127.0.0.1:8000/api/layers/<system>/query/status'`, or `just <system> tsf status` locally |

3. After a first launch, run `key` for the target repository on both VMs and `token` on the gaffer VM, unless the user said not to.
4. On a script failure, report its last lines and stop.

## Report

- The system, where it runs and its URL (`https://<vm>.exe.xyz` or the local URL).
- What the action changed: VM created or redeployed, deploy key added, token stored.
- What the user still has to do on the screens: Start on the Builder screen, and on the Gaffer screen set the board, repository and branch, then Set up and Start.
