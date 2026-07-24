---
name: project-management
description: Handles task tracking, epics, and user stories using the GitHub CLI (gh). Connects to the Neiist website board (GitHub Projects V2) to keep task status synced.
---

# Skill: project-management

## Objective
Automatically manage tasks, epics, and issues on the user's GitHub Project board (`Neiist website board`) so that development progress is tracked and visible.

## CLI Commands for Project Management
You must use the `gh` (GitHub CLI) to interact with issues and projects.
**Important Rule**: ALWAYS prefix your commands with `unset GITHUB_TOKEN && ` to ensure you use the correct keyring authentication instead of a potentially restricted environment variable.

### 1. Creating a Task (Issue)
When a plan is approved and tasks are defined, create them as GitHub issues:
```bash
unset GITHUB_TOKEN && gh issue create --title "[Task Title]" --body "[Task Description / Acceptance Criteria]"
```
*(This command outputs the URL of the created issue, which you will need for the next step).*

### 2. Linking the Task to the Kanban Board
After creating the issue, immediately add it to the "Neiist website board" (Project 1, owned by `tomasmbrito`):
```bash
unset GITHUB_TOKEN && gh project item-add 1 --owner tomasmbrito --url <ISSUE_URL>
```

### 3. Closing a Task
When a task is completed and verified locally:
```bash
unset GITHUB_TOKEN && gh issue close <ISSUE_NUMBER>
```
*(GitHub automatically moves closed issues to the 'Done' column in standard project configurations).*

## Workflow Integration
1. **During `/plan`**: Break down the implementation plan into clear GitHub Issues.
2. **After Plan Approval**: Create the issues and link them to the Project board.
3. **During Execution**: Provide status updates referring to the issue numbers.
4. **On Completion**: Close the issues.
