# dsh-whale-paywall

A **simulated** paywall for DeepSeek Harness. It charges "whale coins" for actions you normally take for granted. **No real money is involved** — it only shows a dialog.

Works in all 8 UI languages DSH ships (Chinese, English, Japanese, German, Spanish, French, Portuguese, Russian).

## What it charges

| Action | Price |
|---|---|
| Starting a session | 6 coins |
| Archiving a session | 1 coin |
| Downloading a plugin | 12 coins |
| Opening Settings | 1 coin |
| Enabling a plugin | 1 coin |
| Web search (`web_search` / `web_fetch`) | 1 coin |
| Switching models | 1 coin |

**Spending order:** remaining uses first, then coins. Blocked only when both run out.

You start with **50 coins**. Every action opens the dialog — even when you can afford it. That is the joke, not a bug.

## The mall

**Settings → Mall** (last entry in the nav).

| Package | Price | Contents |
|---|---|---|
| Starter | 16 coins | 3 sessions · 9 archives · 1 plugin download · 3 searches · 1 model switch · 1 plugin enable |
| Session pack | 30 coins | 6 sessions |
| Archive pack | 6 coins | 10 archives |
| Plugin pack | 60 coins | 10 plugin downloads |

The mall shows your balance and the remaining uses for each of the seven actions. When a count hits zero the cell turns red and shows the per-use price.

## It will not lock you out

The dialog is a full-screen layer, so it is built so it cannot trap you:

- The backdrop is `pointer-events: none` — only the card is clickable, so the page underneath stays usable
- A React error boundary closes it if the card ever fails to render
- Any dialog auto-closes after **25 seconds**, and `Esc` closes it too
- When the balance cannot be read, it **allows** the action rather than blocking everything

## Only entering Settings is charged

Once you are inside Settings, clicking around — switching to the mall, toggling options, browsing models — costs nothing. Only the act of opening Settings costs 1 coin.

## Where the data lives

`$DSH_HOME/whale-paywall.wallet.json`. Both halves read and write the same file. Delete it and you are back to the initial 50 coins / 0 uses.

## Install

**From the plugin market:** search for `dsh-whale-paywall`.

**From this repo:** copy the folder anywhere, then use **Plugins → Add plugin** and point it at the directory. No configuration files need editing — the bundled `cordis.patch.yml` inserts itself.

## Uninstall

Disable or remove the plugin. All charges and dialogs disappear immediately; the wallet file stays where it is.

## License

MIT
