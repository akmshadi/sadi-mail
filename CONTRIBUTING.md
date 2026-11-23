# Contributing

Thank you for helping. Bug reports, fixes and improvements are welcome.

## Running It

```bash
pnpm install
```

```bash
pnpm dev
```

```bash
pnpm seed
```

## Before You Send A Change

```bash
pnpm typecheck
```

```bash
pnpm test
```

Both must pass. A change in behaviour needs a test that would have failed without it. Tests run inside the Workers runtime and never reach a real mailbox, a real model or the network.

## Ground Rules

- **Say only what is true.** If something is written but not proven against the real service, the README says so. Keep it that way.
- **No secrets, real addresses or real domains** in code, tests or documentation. Use `example.com` and names ending in `.example`.
- **Everything stays on Cloudflare** by default. A new outside service must be optional and off until the person turns it on.
- **Interface text:** headings, labels, tabs and buttons in Title Case; sentences in sentence case. Warnings are a neutral surface with a border and a small coloured dot, never a tinted fill.
- **Every screen works on a phone, a tablet and a desktop.**
- A database change is a new numbered file in `migrations/`. Never edit one that has shipped.

## Where Things Are

See [docs/architecture.md](docs/architecture.md) for a map of every folder, file and table.
