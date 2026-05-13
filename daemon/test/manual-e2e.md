# VOS-77 manual e2e — Obsidian + claudev + vault.read

This is the hand-verification step from the VOS-77 acceptance list. CI does not
run it. Engineer runs once at task close, pastes the resulting daemon log
snippet into the task Work Log.

## Setup

1. Start (or restart) the daemon:

       brew services restart void-os
       # or, if not installed via brew, from the void-os repo:
       cd /Users/admin/void-os/daemon && bun run start

2. Open the vault in Obsidian:

       open -a Obsidian "$VOID_OS_VAULT_ROOT"
       # default vault root: ~/Library/Application Support/void-os/vault

3. In any note, type a unique marker. Example:

       manual-e2e marker $(date +%s)

   Save the note. Note its path relative to the vault root, e.g.
   `daily/2026-05-13.md`.

## Happy path

4. Write a temporary MCP config:

       cat > /tmp/void-os-mcp.json <<'JSON'
       {
         "mcpServers": {
           "void-os": { "type": "http", "url": "http://127.0.0.1:7777/mcp" }
         }
       }
       JSON

5. Run claudev:

       claudev --mcp-config /tmp/void-os-mcp.json \
               -p "Use vault.read to fetch daily/2026-05-13.md and tell me the marker."

6. Confirm claudev's reply mentions the marker text.

7. Confirm the daemon recorded the call:

       sqlite3 "$VOID_OS_DB" \
         "select ts, type, json_extract(data,'$.ok'), json_extract(data,'$.input.path') \
          from events where type like 'mcp.%' order by ts desc limit 5;"
       # default db path: ~/Library/Application Support/void-os/state.sqlite

   Expected: a row with `type='mcp.vault.read'`, ok=1, path matching the note.

## Teardown

8. If you started the daemon manually in step 1, stop it (`Ctrl-C`). If it's
   under `brew services`, leave it.

9. Remove `/tmp/void-os-mcp.json`.

## Pass criteria

- Step 6 PASS (claudev reply contains marker)
- Step 7 PASS (events row exists, ok=1)
