# Start Here

This is your factory: a small web app with one durable agent that works on your project while you watch. Everything it knows lives in plain files under `tsf/`, and everything you can do in the screen, the agent can do too.

## The three panes

- **Pages** (left): a tree of Markdown pages and folders. They are ordinary files in `tsf/pages/`, so you can edit them in any editor and the tree follows.
- **Focus** (centre): the page you have selected, rendered as Markdown. Select a page in the tree, or ask the agent to select one.
- **Agent** (right): the chat with the agent. It can read, create and move pages, and its work survives a restart: if the server stops mid-turn, the turn finishes when it starts again.

## Try these prompts

1. `ping`
2. Explain the basics of Python, TypeScript and Rust in nested folders in our pages.
3. Summarise what is in our pages and tell me which page to read first.

## Where things live

- `tsf/pages/` holds these pages.
- `tsf/layers/` holds your own layers: folders with a `manifest.ts` and an `extension.ts`.
- `tsf/permissions.json` sets the ceiling on which tools the agent may have. Only you edit it.
- `tsf/data/` holds the agent's database and logs, and is not committed.
