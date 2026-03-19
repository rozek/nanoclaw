---
name: pwd
description: Report the current working folder shown in the NanoClaw browser UI. Use when the user asks which folder is currently active.
---

# Querying the Working Folder (`/pwd`)

The current working folder is determined by the most recent `switching to folder: <path>` line that appeared in the conversation (from you or the user).

When the user asks for the current working folder:

1. Check the conversation history for the most recent `switching to folder: <path>` line.
2. Report that path to the user.
3. If no such line exists in the conversation, the working folder is the workspace root.

## Notes

- The working folder is shown in the browser header as: `NanoClaw — host:port — <relative-path>`
- To change the working folder, use the `cwd` skill (output `switching to folder: <path>` in your response)
