# tinyclaw

Drive **Claude Code**, **Codex** and **GitHub Copilot CLI** — plus an ordinary
shell — from a WhatsApp chat. The bridge links to WhatsApp as a companion device
via [Baileys](https://github.com/WhiskeySockets/Baileys), runs the CLIs on your
box, and streams what they are doing back into the chat.

```
you  ▸ /cd tinyclaw
     ◂ 📁 `~/tinyclaw`
you  ▸ /agent claude
     ◂ ⏺ attached to *claude* 2.1.220
       🆕 new session on your next message
you  ▸ there's a bug in calc.py, find and fix it

     ◂ ⏺ claude · ~/tinyclaw · ba2332dd   19s
       $ Bash  find . -maxdepth 3 -iname "calc.py"
       👁 Read  /tmp/tinyclaw-demo/calc.py
       ✎ Edit  /tmp/tinyclaw-demo/calc.py
       $ Bash  python3 -c "from calc import add; print(add(2,3))"
         ↳ 5
       working…

     ◂ Fixed: `add` was doing `a-b` instead of `a+b` in calc.py:2.
       Verified `add(2,3)` now returns `5`.

     ◂ ✅ claude · 21s · 4 steps · $0.102 · ba2332dd
you  ▸ !sudo apt install -y ripgrep
     ◂ ✅ shell · 4.1s · exit 0
```

That middle block is **one message being edited in place** as the agent works,
so a long turn reads as a live status card instead of fifty notifications.

## What you get

- **Three agents, one interface.** `claude`, `codex` and `copilot` behind a
  single adapter, each using its own native session store so conversations you
  started in a terminal show up in chat and vice versa.
- **Session browsing.** `/dirs` lists every directory the CLIs have history in;
  `/sessions` lists the conversations in the current one; `/resume 3` picks one
  up where you left off.
- **Real multi-turn context.** Claude runs as a persistent `stream-json` process
  so follow-ups stay in the same session; codex and copilot resume by id.
- **A shell.** `!<cmd>` runs anything, `sudo` included, with live-tailing output.
- **Guard rails.** An allowlist of phone numbers, a block on obviously
  catastrophic commands (overridable with `!!`), and credential redaction on
  everything leaving the box.

## Requirements

- Node 20+
- Whichever CLIs you want to use, already installed **and logged in**:
  - `claude` — [Claude Code](https://claude.com/claude-code)
  - `codex` — `npm i -g @openai/codex`
  - `copilot` — `npm i -g @github/copilot`
- A WhatsApp account you can link a device to.

## Setup

```bash
cd tinyclaw
npm install
npm run build

cp .env.example .env
$EDITOR .env          # at minimum, set TINYCLAW_ALLOWED

npm start
```

On first run you will be asked to link the device:

- **QR code** (default) — a QR is printed to the terminal. On your phone:
  *WhatsApp → Settings → Linked devices → Link a device*.
- **Pairing code** — set `TINYCLAW_PAIR_NUMBER` to the phone's number and an
  8-character code is printed instead. On your phone: *Link a device → Link with
  phone number instead*.

Credentials are written to `.auth/` and reused on restart.

### Which account should I link?

**Link your own account** (simplest). tinyclaw becomes another linked device on
your WhatsApp, and you drive it from the **"Message yourself"** chat. Nothing
else can reach it — that chat is only visible to you. `TINYCLAW_ALLOWED` can stay
empty.

**Link a second number.** tinyclaw owns a dedicated WhatsApp account and you
message it from your personal number, which must be in `TINYCLAW_ALLOWED`. Use
this if you want other people to be able to use it too.

## Usage

Anything you type that is not a command is sent to the attached agent. Two
prefixes change that:

| Input | Meaning |
| --- | --- |
| `some text` | prompt for the attached agent |
| `!cmd` | run `cmd` in the shell |
| `!!cmd` | run `cmd` past the safety guard |
| `/cmd` | a bridge command |

**Send `help` to get the command list in the chat.** No slash needed — `help`,
`?`, `menu` and `commands` all work on their own, so you never have to remember
the syntax to find the syntax. They only trigger when they are the whole
message, so "help me fix the build" still goes to the agent.

### Commands

| Command | What it does |
| --- | --- |
| `/help` | the list below, in chat (or just send `help`) |
| `/status` | directory, agent, session, permission, what's running |
| `/agent [claude\|codex\|copilot]` | attach an agent; no argument lists availability |
| `/sessions [agent]` | past sessions in this directory |
| `/resume <N\|id>` | continue one of them |
| `/new [prompt]` | start a fresh session here |
| `/cd <path\|N\|->` | change directory; `N` picks from the last `/dirs` |
| `/ls [path]`, `/pwd` | look around |
| `/dirs` | directories the CLIs have history in |
| `/model [name]` | model for the attached agent |
| `/perm [read\|write\|full]` | how much the agent may do |
| `/stop` | interrupt the running turn or command |
| `/last` | resend the last shell output in full |
| `/verbose [on\|off]` | show tool results as well as tool calls |
| `/detach` | stop forwarding plain messages |
| `/whoami` | your number, and whether you're the owner |
| `/who`, `/allow <n>`, `/deny <n>` | manage the allowlist (owner only) |

`/stop` and `/status` jump the queue; everything else runs in order, so messages
sent while an agent is working are queued rather than dropped.

### Directories and sessions

Each chat has its own working directory and its own attached agent. tinyclaw
remembers the last session per *(agent, directory)* pair, so `/cd` away and back
lands you in the same conversation:

```
/dirs                 → 1. ~/tinyclaw ⏺◆   2h ago
                        2. ~/llama.cpp ⏺   1d ago
/cd 2                 → 📁 ~/llama.cpp
/sessions             → 1. ⏺ claude · 3h ago · a41f9c22
                             Speed up the ggml matmul path
/resume 1             → ⏺ resuming claude a41f9c22
where did we get to?  → …
```

Session lists are read straight from each CLI's own store
(`~/.claude/projects`, `~/.codex/sessions`, `~/.copilot/session-state`), so
terminal and phone see the same history.

### Permissions

`/perm` maps one vocabulary onto three different CLIs:

| | `read` | `write` | `full` (default) |
| --- | --- | --- | --- |
| claude | `--permission-mode plan` | `acceptEdits` | `bypassPermissions` |
| codex | `sandbox_mode=read-only` | `workspace-write` | `--dangerously-bypass-approvals-and-sandbox` |
| copilot | `--mode plan` | `--allow-all-tools` | `--allow-all` |

The default is **`full`**, because a chat-driven agent that stops to ask for
permission on every tool call is unusable — and because in non-interactive mode
`write` means Claude Code will silently *refuse* shell commands rather than ask.
Set `TINYCLAW_DEFAULT_PERMISSION=write` if you would rather trade capability for
caution.

## Security

Read this part.

**This gives anyone on the allowlist a root-capable shell on your machine.**
`sudo` works if it works for you, and in `full` permission the agents run their
own commands unsupervised. The allowlist is the only real boundary; everything
else is a speed bump.

- **Allowlist.** Numbers in `TINYCLAW_ALLOWED`, plus the linked account's own
  chat. Everyone else gets a refusal and a line in the log. Group chats are
  ignored unless `TINYCLAW_ALLOW_GROUPS=true`.
- **`.auth/` is a credential.** Anyone who copies that directory can act as your
  WhatsApp account. It is in `.gitignore`; keep it that way, and keep the mode
  tight (`chmod 700`).
- **Command guard.** A short list of unrecoverable commands — `rm -rf /`,
  `mkfs`, `dd` to a block device, `shutdown`, flushing the firewall, stopping
  sshd, piping curl into a shell — is blocked and must be confirmed with `!!`.
  This is a defence against a fat-fingered phone keyboard, *not* against a
  hostile user. Disable with `TINYCLAW_GUARD_SHELL=false`.
- **Redaction.** Output is scanned for API-key- and token-shaped strings and
  private key blocks before it is sent. Best-effort pattern matching, not a
  guarantee.
- **WhatsApp is not your threat model's friend.** Messages are end-to-end
  encrypted, but the transcript lives on your phone and in cloud backups, and a
  linked device is one lost phone away from being someone else's. Do not put
  anything through here you would not put in a chat.

## Running as a service

```bash
sudo cp tinyclaw.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tinyclaw
journalctl -u tinyclaw -f          # the QR / pairing code appears here
```

Edit `User=`, `WorkingDirectory=` and `PATH=` in the unit to match your box. The
`PATH` matters: systemd's default does not include `~/.local/bin`, which is
where the CLIs usually land.

## Development

```bash
npm run build          # tsc
npm run typecheck
npm run selftest       # everything except the WhatsApp socket
```

The self-test drives the real router over a console transport — commands,
directory handling, shell execution, the danger rules, allowlist enforcement,
and session discovery against whatever CLI history exists on the box. Add
`--live` to also run two real agent turns and check that session context carries
across them:

```bash
npm run selftest -- --live --agent claude     # costs a couple of API calls
npm run selftest -- --echo                    # print every outbound message
```

### Layout

```
src/
  index.ts          startup, config, signal handling
  whatsapp.ts       Baileys socket, login, reconnect, inbound normalisation
  transport.ts      the chat surface, abstracted (console impl for tests)
  router.ts         command table and dispatch
  session.ts        per-chat runtime: turns, shell jobs, directory state
  ui.ts             chunking, Markdown→WhatsApp, the live status message
  shell.ts          process execution with streaming and timeouts
  security.ts       allowlist, danger rules, redaction
  state.ts          persisted per-chat state
  agents/
    types.ts        the adapter interface
    claude.ts       persistent stream-json process
    codex.ts        exec --json / exec resume
    copilot.ts      -p --output-format json / --resume
```

Adding a fourth CLI means implementing `AgentAdapter`: a version probe, session
discovery from wherever it keeps history, and a `Conversation` that turns its
output into `AgentEvent`s. Nothing above `agents/` needs to change.

## Known limits

- WhatsApp only lets you edit a message for about 15 minutes. Past that the live
  status card stops updating in place and posts a fresh message instead.
- Media is ignored — captions on images are read as text, but the image itself
  is not passed to the agent.
- One turn at a time per chat. Messages sent during a turn are queued.
- Interrupting Claude mid-turn asks it to stop first and kills the process if it
  does not; the partial turn is still saved and resumed on your next message.
