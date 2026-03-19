---
name: cwd
description: Change the working folder shown in the NanoClaw browser UI header. Use whenever you start working in a different project directory and want the user to see which folder is active.
---

# Changing the Working Folder (`/cwd`)

To update the working folder displayed in the NanoClaw browser UI, include the following line **on its own line** anywhere in your response:

```
switching to folder: <relative-path>
```

`<relative-path>` is relative to the NanoClaw workspace root. Examples:

```
switching to folder: Projects/my-app
switching to folder: Reports/2026-Q1
switching to folder: .
```

## When to use

- When you navigate into a project directory to work on it
- When the user asks you to change the working folder
- When you switch context from one project to another

## Notes

- The path is displayed in the browser header as: `NanoClaw — host:port — <relative-path>`
- A dot (`.`) resets the display to the workspace root
- The path is persisted in the database and survives browser reloads
