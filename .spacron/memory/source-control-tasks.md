# Source control task panel and PR merge safety

The Tasks panel features a tabbed view (`Board`, `Issues`, `Pull Requests`) bridging local board tasks and remote provider work items.

### Auth token resolution
Remote calls (`source_control.rs`) query the system keychain for provider tokens, falling back to `gh auth token` via GitHub CLI if no explicit token is saved in the app. This allows zero-config PR/issue inspection when the developer already runs GitHub CLI locally.

### PR merge safety
When merging a pull request from the UI (`source_control_merge_pr`), the frontend passes `expectedHeadSha` (the SHA inspected in the UI). The backend forwards this `sha` parameter to GitHub's merge endpoint (`PUT /repos/{owner}/{repo}/pulls/{number}/merge`). If additional commits were pushed to the remote PR branch between inspection and merge click, GitHub rejects the request with HTTP 409 Conflict, preventing unintended merges of unreviewed commits.

### Master-detail surface
Issues and Pull Requests operate via master-detail switching within the panel rather than launching modal dialogs, preserving context and keyboard flow. Modals are reserved for item creation (`TasksNewIssueModal`, `TasksNewPRModal`).
