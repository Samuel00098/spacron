# Orchestrator skills and app commands

**Skills** (`services/orchestrator/skills.ts`) go into the brain's system prompt
on every turn, after the rules and before the tools. Settings > Orchestrator
switches built-ins off (`orchestratorDisabledSkills`, by id) and stores the
user's own (`orchestratorCustomSkills`). Both keys must stay declared in
`stores/zustand/settings.ts` as well as `stores/settings.ts`, or the value
resets every launch. The brain test mocks `$lib/stores/settings`, so a new
skill store needs adding to that mock too.

**App commands**: `list_app_commands` / `run_app_command` expose the whole
command palette to the brain, so a new palette command needs no brain change.
The user chose "risky commands only after I click Approve", in EVERY access
mode, Full access included. Three pieces keep that true:

1. `isRiskyAppCommand` (app-commands.ts) decides by words in the id and name.
2. The store's `executeToolWithActivity` ORs `riskyAppCommand` into
   `needsApproval` outside the full-access check.
3. `approvalRuleKey` keys app commands per command id (`app:<id>`), so
   "Always allow" on one risky command never allows the others.

Related: [[orchestrator-approval-cards]], [[command-palette-registry]].
